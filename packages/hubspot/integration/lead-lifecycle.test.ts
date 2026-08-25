import { beforeEach, describe, expect, it } from 'vitest';
import type { FeatureFlags } from '@am/domain';
import {
  FIXTURE_ACQUISITION,
  FIXTURE_MAPPING,
  FIXTURE_SUBMISSION,
  FixtureHubspotProvider,
  createFixtureClock,
  createInMemorySyncStore,
  createHubspotProvider,
  reconcile,
  requiredMappingsComplete,
  runTestLead,
  syncLead,
  toCanonicalEvents,
  type InMemorySyncStore,
  type ObjectSnapshot,
  type SyncDeps,
} from '../src/index';

/**
 * End-to-end flows against the fixture provider. No network, no database:
 * everything runs through the same code paths the live adapter uses, with the
 * provider and the `SyncStore` port swapped for in-memory implementations.
 */

const WRITES_ON: FeatureFlags = {
  demoMode: true,
  externalWritesEnabled: true,
  metaMutationsEnabled: false,
  metaCapiEnabled: false,
  hubspotWritesEnabled: true,
};

function uuidFactory(prefix = 1): () => string {
  let n = prefix * 1000;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
}

let provider: FixtureHubspotProvider;
let store: InMemorySyncStore;
let deps: SyncDeps;
let clock: () => string;

beforeEach(() => {
  clock = createFixtureClock('2026-02-03T10:15:00.000Z');
  provider = new FixtureHubspotProvider({ flags: WRITES_ON, clock });
  store = createInMemorySyncStore();
  deps = {
    provider,
    store,
    flags: WRITES_ON,
    now: clock,
    newUuid: uuidFactory(),
  };
});

const input = {
  submission: FIXTURE_SUBMISSION,
  acquisition: FIXTURE_ACQUISITION,
  mapping: FIXTURE_MAPPING,
};

describe('lead → opportunity → close, against the fixture CRM', () => {
  it('walks the whole funnel and emits one event per real transition', async () => {
    // 1. The form submit: contact + company + association, no deal.
    const submitted = await syncLead(input, deps);
    expect(submitted.status).toBe('SYNCED');
    expect(provider.listAll('deals')).toHaveLength(0);
    expect(store.eventTypes()).toEqual(['FORM_COMPLETED']);

    // 2. The VQ is scheduled — the mapped trigger — so the deal appears.
    const scheduled = await syncLead({ ...input, triggerEvent: 'VQ_SCHEDULED' }, deps);
    const dealId = scheduled.opportunity?.hubspotDealId;
    expect(dealId).toBeTruthy();
    expect(provider.listAll('deals')).toHaveLength(1);

    // The contact↔deal association is a record of its own.
    const associations = await provider.batchReadAssociations({
      fromObjectType: 'contacts',
      toObjectType: 'deals',
      fromObjectIds: [submitted.lead.hubspotContactId ?? ''],
    });
    expect(associations[0].toObjectIds).toContain(dealId);

    // 3. Sales moves the deal forward in HubSpot.
    provider.patchObject(dealId ?? '', { dealstage: 'qualifiedtobuy' });
    const first = await reconcile({ scope: 'DAILY', mapping: FIXTURE_MAPPING }, deps);
    expect(first.eventsEmitted.map((e) => e.type)).toEqual(['VQ_PASSED']);

    // 4. A second reconciliation with no CRM change emits nothing.
    const second = await reconcile({ scope: 'DAILY', mapping: FIXTURE_MAPPING }, deps);
    expect(second.eventsEmitted).toEqual([]);
    expect(second.discrepancies).toEqual([]);
    expect(second.messagesDe.join(' ')).toMatch(/keine Abweichungen/);

    // 5. Closed won, with the amount carried in minor units.
    provider.patchObject(dealId ?? '', {
      dealstage: 'closedwon',
      amount: '18500.00',
      deal_currency_code: 'EUR',
      closedate: '2026-02-20T00:00:00.000Z',
    });
    const won = await reconcile({ scope: 'DAILY', mapping: FIXTURE_MAPPING }, deps);
    const closedWon = won.eventsEmitted.find((e) => e.type === 'CLOSED_WON');
    expect(closedWon?.amountMinor).toBe(1_850_000);
    expect(closedWon?.currency).toBe('EUR');
    expect(store.opportunities.get(scheduled.opportunity?.amOpportunityId ?? '')?.closedWonAt).toBe(
      '2026-02-20T00:00:00.000Z',
    );
  });
});

describe('drift after a dispatched conversion', () => {
  it('records a discrepancy and a revenue adjustment instead of a second CLOSED_WON', async () => {
    await syncLead({ ...input, triggerEvent: 'VQ_SCHEDULED' }, deps);
    const opportunity = [...store.opportunities.values()][0];
    const dealId = opportunity.hubspotDealId ?? '';

    provider.patchObject(dealId, {
      dealstage: 'closedwon',
      amount: '18500.00',
      closedate: '2026-02-20T00:00:00.000Z',
    });
    const converted = await reconcile({ scope: 'DAILY', mapping: FIXTURE_MAPPING }, deps);
    expect(converted.eventsEmitted.filter((e) => e.type === 'CLOSED_WON')).toHaveLength(1);

    // Sales corrects the value afterwards.
    provider.patchObject(dealId, { amount: '21000.00' });
    const drift = await reconcile({ scope: 'DAILY', mapping: FIXTURE_MAPPING }, deps);

    expect(drift.eventsEmitted.filter((e) => e.type === 'CLOSED_WON')).toHaveLength(0);
    expect(drift.discrepancies).toHaveLength(1);
    expect(drift.discrepancies[0].kind).toBe('REVENUE_CHANGED_AFTER_CONVERSION');
    expect(drift.discrepancies[0].deltaMinor).toBe(250_000);
    expect(drift.discrepancies[0].resolutionDe).toMatch(/kein zweites CLOSED_WON/);
    expect(drift.correctionsDe[0]).toMatch(/Umsatzkorrektur/);

    expect(store.revenueEvents).toHaveLength(1);
    expect(store.revenueEvents[0]).toMatchObject({
      kind: 'ADJUSTMENT',
      amountMinor: 2_100_000,
      reconciliationDeltaMinor: 250_000,
      currency: 'EUR',
    });
    expect(store.eventTypes().filter((t) => t === 'CLOSED_WON')).toHaveLength(1);
  });

  it('reports a stage change the mapping does not cover as drift, not as an event', async () => {
    await syncLead({ ...input, triggerEvent: 'VQ_SCHEDULED' }, deps);
    const dealId = [...store.opportunities.values()][0].hubspotDealId ?? '';
    await reconcile({ scope: 'DAILY', mapping: FIXTURE_MAPPING }, deps);

    const unmapped = {
      ...FIXTURE_MAPPING,
      stageEvents: FIXTURE_MAPPING.stageEvents.filter((r) => r.stageId !== 'qualifiedtobuy'),
    };
    provider.patchObject(dealId, { dealstage: 'qualifiedtobuy' });

    const report = await reconcile({ scope: 'DAILY', mapping: unmapped }, deps);
    expect(report.eventsEmitted).toEqual([]);
    expect(report.discrepancies.map((d) => d.kind)).toEqual(['STAGE_DRIFT']);
    expect(report.discrepancies[0].messageDe).toMatch(/kein kanonisches Ereignis gemappt/);
  });

  it('flags a deal that lost its contact association', async () => {
    provider.seedObject({
      objectType: 'deals',
      id: '7777',
      properties: { pipeline: 'default', dealstage: 'appointmentscheduled' },
    });
    await store.saveMirror({
      objectType: 'deals',
      objectId: '7777',
      properties: { pipeline: 'default', dealstage: 'appointmentscheduled' },
      observedAt: clock(),
    });

    const report = await reconcile({ scope: 'DAILY', mapping: FIXTURE_MAPPING }, deps);
    expect(report.discrepancies.some((d) => d.kind === 'ASSOCIATION_MISSING')).toBe(true);
  });

  it('flags a mirrored deal that no longer exists in the CRM', async () => {
    await store.saveMirror({
      objectType: 'deals',
      objectId: 'geloescht-1',
      properties: { dealstage: 'appointmentscheduled' },
      observedAt: clock(),
    });
    const report = await reconcile({ scope: 'DAILY', mapping: FIXTURE_MAPPING }, deps);
    expect(report.discrepancies.some((d) => d.kind === 'OBJECT_MISSING_IN_CRM')).toBe(true);
  });
});

describe('hourly reconciliation', () => {
  it('advances its cursor and re-reads only what changed', async () => {
    await syncLead({ ...input, triggerEvent: 'VQ_SCHEDULED' }, deps);
    const dealId = [...store.opportunities.values()][0].hubspotDealId ?? '';

    const first = await reconcile({ scope: 'HOURLY', mapping: FIXTURE_MAPPING }, deps);
    expect(first.objectsRead).toBe(1);
    expect(first.nextCursor?.objectType).toBe('deals');

    const idle = await reconcile(
      { scope: 'HOURLY', mapping: FIXTURE_MAPPING, cursor: first.nextCursor },
      deps,
    );
    expect(idle.eventsEmitted).toEqual([]);

    provider.patchObject(dealId, { dealstage: 'qualifiedtobuy' });
    const changed = await reconcile(
      { scope: 'HOURLY', mapping: FIXTURE_MAPPING, cursor: idle.nextCursor },
      deps,
    );
    expect(changed.eventsEmitted.map((e) => e.type)).toEqual(['VQ_PASSED']);
  });
});

describe('outage resilience', () => {
  it('never loses a lead and completes the sync on a later retry', async () => {
    provider.simulateOutage(true);
    const failed = await syncLead(input, deps);
    expect(failed.status).toBe('FAILED_RETRYING');
    expect(store.leads.size).toBe(1);

    provider.simulateOutage(false);
    const retried = await syncLead(input, deps);
    expect(retried.status).toBe('SYNCED');
    expect(provider.listAll('contacts')).toHaveLength(1);
    expect(store.eventTypes()).toEqual(['FORM_COMPLETED']);
  });
});

describe('the wizard test lead', () => {
  it('sends, verifies and marks the probe, and unlocks the launch gate', async () => {
    const result = await runTestLead(
      { mapping: FIXTURE_MAPPING, initiatedBy: '00000000-0000-4000-8000-00000000dead' },
      { provider, store, flags: WRITES_ON, now: clock, newUuid: uuidFactory(9) },
    );

    expect(result.status).toBe('PASS');
    expect(result.gatePassed).toBe(true);
    expect(result.email.endsWith('@fixture.invalid')).toBe(true);
    expect(result.contactId).toBeTruthy();
    expect(result.dealId).toBeTruthy();
    expect(result.associationVerified).toBe(true);
    expect(result.cleanup).toBe('MARKED');
    expect(result.steps.every((s) => s.status !== 'FAIL')).toBe(true);
    expect(result.messagesDe.join(' ')).toMatch(/erfolgreich/);

    const contact = provider.listAll('contacts').find((c) => c.id === result.contactId);
    expect(contact?.properties.am_test_record).toBe('AM_TEST_LEAD');
  });

  it('stays a dry run — and keeps the gate closed — while writes are disabled', async () => {
    const flags: FeatureFlags = {
      ...WRITES_ON,
      externalWritesEnabled: false,
      hubspotWritesEnabled: false,
    };
    const dryProvider = new FixtureHubspotProvider({ flags, clock });
    const result = await runTestLead(
      { mapping: FIXTURE_MAPPING, initiatedBy: '00000000-0000-4000-8000-00000000dead' },
      {
        provider: dryProvider,
        store: createInMemorySyncStore(),
        flags,
        now: clock,
        newUuid: uuidFactory(7),
      },
    );

    expect(result.status).toBe('DRY_RUN');
    expect(result.gatePassed).toBe(false);
    expect(dryProvider.listAll('contacts')).toHaveLength(0);
    expect(result.messagesDe.join(' ')).toMatch(/Dry-Run/);
  });

  it('waits for the operator instead of failing when the mapping is incomplete', async () => {
    const incomplete = {
      ...FIXTURE_MAPPING,
      pipeline: { ...FIXTURE_MAPPING.pipeline, pipelineId: null },
    };
    expect(requiredMappingsComplete(incomplete)).toBe(false);

    const result = await runTestLead(
      { mapping: incomplete, initiatedBy: '00000000-0000-4000-8000-00000000dead' },
      { provider, store, flags: WRITES_ON, now: clock, newUuid: uuidFactory(5) },
    );
    expect(result.status).toBe('AWAITING_EXTERNAL_INPUT');
    expect(result.gatePassed).toBe(false);
    expect(provider.listAll('contacts')).toHaveLength(0);
  });
});

describe('provider factory', () => {
  it('selects the fixture provider in demo mode without touching credentials', async () => {
    const selected = createHubspotProvider({ mode: 'FIXTURE', flags: WRITES_ON, clock });
    const probe = await selected.health();
    expect(probe.state).toBe('FIXTURE');
    expect(probe.state).not.toBe('CONNECTED');
  });

  it('refuses a live provider without a token instead of faking a connection', () => {
    expect(() => createHubspotProvider({ mode: 'LIVE', flags: WRITES_ON, token: null })).toThrowError(
      /HUBSPOT_PRIVATE_APP_TOKEN/,
    );
  });
});

describe('seeded fixture CRM', () => {
  it('translates the seeded portal into canonical events on first observation', async () => {
    const seeded = new FixtureHubspotProvider({
      flags: WRITES_ON,
      clock: createFixtureClock(),
      seed: (await import('../src/index')).createFixtureCrmSeed(),
    });

    const records = await seeded.batchReadObjects({
      objectType: 'deals',
      ids: ['701', '702'],
      properties: ['dealstage', 'pipeline', 'amount', 'deal_currency_code', 'closed_lost_reason'],
    });
    expect(records).toHaveLength(2);

    const events = records.flatMap((record) => {
      const after: ObjectSnapshot = {
        objectType: record.objectType,
        objectId: record.id,
        properties: record.properties,
        observedAt: record.updatedAt,
      };
      return toCanonicalEvents({ before: null, after, mapping: FIXTURE_MAPPING });
    });
    expect(events.map((e) => e.type).sort()).toEqual(['CLOSED_LOST', 'VQ_PASSED']);
  });
});
