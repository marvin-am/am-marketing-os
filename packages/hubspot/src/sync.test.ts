import { describe, expect, it } from 'vitest';
import { DomainError, type FeatureFlags } from '@am/domain';
import {
  FIXTURE_ACQUISITION,
  FIXTURE_FREEMAIL_SUBMISSION,
  FIXTURE_MAPPING,
  FIXTURE_SUBMISSION,
  INCOMPLETE_FIXTURE_MAPPING,
  createFixtureClock,
  createInMemorySyncStore,
} from './fixtures';
import { FixtureHubspotProvider } from './provider-fixture';
import {
  mappedContactProperties,
  mappedDealProperties,
  preserveAcquisition,
  syncLead,
  type SyncDeps,
} from './sync';

const WRITES_ON: FeatureFlags = {
  demoMode: true,
  externalWritesEnabled: true,
  metaMutationsEnabled: false,
  metaCapiEnabled: false,
  hubspotWritesEnabled: true,
};
const WRITES_OFF: FeatureFlags = { ...WRITES_ON, externalWritesEnabled: false, hubspotWritesEnabled: false };

function uuidFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
}

function harness(flags: FeatureFlags = WRITES_ON) {
  const clock = createFixtureClock('2026-02-03T10:15:00.000Z');
  const provider = new FixtureHubspotProvider({ flags, clock });
  const store = createInMemorySyncStore();
  const deps: SyncDeps = {
    provider,
    store,
    flags,
    now: clock,
    newUuid: uuidFactory(),
  };
  return { provider, store, deps };
}

const baseInput = {
  submission: FIXTURE_SUBMISSION,
  acquisition: FIXTURE_ACQUISITION,
  mapping: FIXTURE_MAPPING,
};

describe('syncLead — writes disabled', () => {
  it('returns a dry run describing exactly what would be sent, and writes nothing', async () => {
    const { provider, deps } = harness(WRITES_OFF);
    const result = await syncLead(baseInput, deps);

    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('PENDING');
    expect(result.status).not.toBe('SYNCED');
    expect(result.dryRuns.length).toBeGreaterThan(0);

    const contactDryRun = result.dryRuns[0];
    expect(contactDryRun.dryRun).toBe(true);
    expect(contactDryRun.provider).toBe('HUBSPOT');
    expect(contactDryRun.operation).toBe('hubspot.upsertContact');
    expect(contactDryRun.blockedByDe).toMatch(/deaktiviert/);
    const wouldSend = contactDryRun.wouldSend as { properties: Record<string, string> };
    expect(wouldSend.properties.email).toBe('nina.weber@beispiel-gmbh.de');

    expect(provider.listAll('contacts')).toHaveLength(0);
    expect(provider.listAll('deals')).toHaveLength(0);
    expect(result.messagesDe.join(' ')).toMatch(/Dry-Run/);
  });

  it('still previews a lead when the mapping is incomplete', async () => {
    const { deps } = harness(WRITES_OFF);
    const result = await syncLead({ ...baseInput, mapping: INCOMPLETE_FIXTURE_MAPPING }, deps);
    expect(result.dryRun).toBe(true);
  });
});

describe('syncLead — mapping gate', () => {
  it('refuses to write to a live portal while the mapping is incomplete', async () => {
    const { deps } = harness(WRITES_ON);
    await expect(
      syncLead({ ...baseInput, mapping: INCOMPLETE_FIXTURE_MAPPING }, deps),
    ).rejects.toMatchObject({ code: 'MAPPING_INCOMPLETE' });
  });
});

describe('syncLead — contact, company and association', () => {
  it('creates the contact by normalised e-mail and attaches the stable person id', async () => {
    const { provider, deps } = harness();
    const result = await syncLead(baseInput, deps);

    expect(result.status).toBe('SYNCED');
    const contacts = provider.listAll('contacts');
    expect(contacts).toHaveLength(1);
    expect(contacts[0].properties.email).toBe('nina.weber@beispiel-gmbh.de');
    expect(contacts[0].properties.am_person_id).toBe(FIXTURE_SUBMISSION.personId);
    expect(result.lead.hubspotContactId).toBe(contacts[0].id);
  });

  it('creates a company for a corporate domain and associates it explicitly', async () => {
    const { provider, deps } = harness();
    const result = await syncLead(baseInput, deps);

    const companies = provider.listAll('companies');
    expect(companies).toHaveLength(1);
    expect(companies[0].properties.domain).toBe('beispiel-gmbh.de');

    const associations = provider.listAssociations();
    expect(
      associations.some(
        (a) =>
          a.fromObjectType === 'contacts' &&
          a.toObjectType === 'companies' &&
          a.toObjectId === companies[0].id,
      ),
    ).toBe(true);
    expect(result.operations.some((o) => o.step === 'CONTACT_COMPANY_ASSOCIATION')).toBe(true);
  });

  it('never creates a company for a freemail domain', async () => {
    const { provider, deps } = harness();
    const result = await syncLead({ ...baseInput, submission: FIXTURE_FREEMAIL_SUBMISSION }, deps);

    expect(provider.listAll('companies')).toHaveLength(0);
    expect(provider.listAll('contacts')).toHaveLength(1);
    const companyStep = result.operations.find((o) => o.step === 'COMPANY');
    expect(companyStep?.outcome).toBe('SKIPPED');
    expect(companyStep?.detailDe).toMatch(/Freemail/);
  });
});

describe('syncLead — the deal trigger', () => {
  it('creates no deal on a plain form submit', async () => {
    const { provider, deps } = harness();
    const result = await syncLead(baseInput, deps);

    expect(provider.listAll('deals')).toHaveLength(0);
    expect(result.opportunity).toBeNull();
    const dealStep = result.operations.find((o) => o.step === 'DEAL');
    expect(dealStep?.outcome).toBe('SKIPPED');
    expect(dealStep?.detailDe).toMatch(/VQ_SCHEDULED/);
  });

  it('creates exactly one deal when the mapped trigger fires', async () => {
    const { provider, deps } = harness();
    await syncLead(baseInput, deps);
    const result = await syncLead({ ...baseInput, triggerEvent: 'VQ_SCHEDULED' }, deps);

    const deals = provider.listAll('deals');
    expect(deals).toHaveLength(1);
    expect(deals[0].properties.am_opportunity_id).toBe(result.opportunity?.amOpportunityId);
    expect(deals[0].properties.pipeline).toBe('default');
    expect(deals[0].properties.dealstage).toBe('appointmentscheduled');

    const associations = provider.listAssociations();
    expect(
      associations.some((a) => a.fromObjectType === 'contacts' && a.toObjectType === 'deals'),
    ).toBe(true);
  });
});

describe('syncLead — idempotency', () => {
  it('yields one contact, one deal and one lead event for ten concurrent syncs', async () => {
    const { provider, store, deps } = harness();

    const runs = await Promise.all(
      Array.from({ length: 10 }, () =>
        syncLead({ ...baseInput, triggerEvent: 'VQ_SCHEDULED' }, deps),
      ),
    );

    expect(provider.listAll('contacts')).toHaveLength(1);
    expect(provider.listAll('deals')).toHaveLength(1);
    expect(store.leads.size).toBe(1);
    expect(store.opportunities.size).toBe(1);
    expect(store.eventTypes().filter((t) => t === 'FORM_COMPLETED')).toHaveLength(1);
    expect(store.eventTypes().filter((t) => t === 'OPPORTUNITY_CREATED')).toHaveLength(1);

    const withEvents = runs.filter((r) => r.events.length > 0);
    expect(withEvents).toHaveLength(1);
    expect(runs.every((r) => r.status === 'SYNCED')).toBe(true);
  });

  it('is idempotent across ten sequential syncs too', async () => {
    const { provider, store, deps } = harness();
    for (let i = 0; i < 10; i += 1) {
      await syncLead({ ...baseInput, triggerEvent: 'VQ_SCHEDULED' }, deps);
    }
    expect(provider.listAll('contacts')).toHaveLength(1);
    expect(provider.listAll('deals')).toHaveLength(1);
    expect(store.events.size).toBe(2);
  });
});

describe('syncLead — failures', () => {
  it('keeps the lead intact through an outage and completes on the retry', async () => {
    const { provider, store, deps } = harness();
    provider.simulateOutage(true);

    const failed = await syncLead(baseInput, deps);
    expect(failed.status).toBe('FAILED_RETRYING');
    expect(failed.retry.lastErrorCode).toBe('PROVIDER_ERROR');
    expect(failed.retry.nextAttemptAt).not.toBeNull();
    expect(failed.messagesDe.join(' ')).toMatch(/Lead bleibt vollständig gespeichert/);
    expect(store.leads.size).toBe(1);
    expect(provider.listAll('contacts')).toHaveLength(0);

    provider.simulateOutage(false);
    const retried = await syncLead(baseInput, deps);
    expect(retried.status).toBe('SYNCED');
    expect(provider.listAll('contacts')).toHaveLength(1);
    expect(store.leads.size).toBe(1);
  });

  it('surfaces PROVIDER_RATE_LIMITED and backs off by the provider Retry-After', async () => {
    const { provider, deps } = harness();
    provider.simulateRateLimit({ times: 1, retryAfterMs: 5_000 });

    const result = await syncLead(baseInput, deps);
    expect(result.status).toBe('FAILED_RETRYING');
    expect(result.retry.lastErrorCode).toBe('PROVIDER_RATE_LIMITED');
    expect(result.retry.lastErrorDe).toMatch(/Anfragelimit/);

    const backoffMs =
      Date.parse(result.retry.nextAttemptAt ?? '') - Date.parse(result.lead.updatedAt);
    expect(backoffMs).toBe(5_000);

    const retried = await syncLead(baseInput, deps);
    expect(retried.status).toBe('SYNCED');
  });

  it('dead-letters a validation error rather than retrying forever', async () => {
    const { provider, deps } = harness();
    provider.simulateValidationError({ times: 1, operations: ['hubspot.upsertContact'] });

    const result = await syncLead(baseInput, deps);
    expect(result.status).toBe('DEAD_LETTER');
    expect(result.retry.nextAttemptAt).toBeNull();
    expect(result.retry.lastErrorCode).toBe('VALIDATION_FAILED');
  });

  it('reports a domain error, never a bare provider exception', async () => {
    const { provider } = harness();
    provider.simulateOutage(true);
    await expect(provider.listProperties('contacts')).rejects.toBeInstanceOf(DomainError);
  });
});

describe('preserveAcquisition', () => {
  it('never lets a later touch overwrite the bound acquisition', () => {
    const existing = {
      am_campaign_id: 'erste-kampagne',
      am_utm_source: 'facebook',
      firstname: 'Nina',
    };
    const incoming = {
      am_campaign_id: 'zweite-kampagne',
      am_utm_source: 'google',
      firstname: 'Nina M.',
    };

    const result = preserveAcquisition(existing, incoming, FIXTURE_MAPPING, 'contact');
    expect(result.am_campaign_id).toBeUndefined();
    expect(result.am_utm_source).toBeUndefined();
    // Non-acquisition fields are still updated.
    expect(result.firstname).toBe('Nina M.');
  });

  it('fills an acquisition slot that is still empty in the CRM', () => {
    const result = preserveAcquisition(
      { am_campaign_id: '', am_utm_source: null },
      { am_campaign_id: 'kampagne', am_utm_source: 'facebook' },
      FIXTURE_MAPPING,
      'contact',
    );
    expect(result.am_campaign_id).toBe('kampagne');
    expect(result.am_utm_source).toBe('facebook');
  });

  it('writes everything when the contact does not exist yet', () => {
    const incoming = { am_campaign_id: 'kampagne' };
    expect(preserveAcquisition(null, incoming, FIXTURE_MAPPING, 'contact')).toEqual(incoming);
  });

  it('can be switched off through the mapping', () => {
    const mapping = {
      ...FIXTURE_MAPPING,
      acquisition: { ...FIXTURE_MAPPING.acquisition, writeOnce: false },
    };
    const result = preserveAcquisition(
      { am_campaign_id: 'erste' },
      { am_campaign_id: 'zweite' },
      mapping,
      'contact',
    );
    expect(result.am_campaign_id).toBe('zweite');
  });
});

describe('acquisition survives a later touch end to end', () => {
  it('keeps the first campaign when the same person submits again', async () => {
    const { provider, deps } = harness();
    await syncLead(baseInput, deps);

    const secondSubmission = {
      ...FIXTURE_SUBMISSION,
      submissionId: '00000000-0000-4000-8000-0000000000ff',
      firstName: 'Nina Maria',
      answers: { ...FIXTURE_SUBMISSION.answers, first_name: 'Nina Maria' },
    };
    const secondAcquisition = {
      ...FIXTURE_ACQUISITION,
      snapshotId: '00000000-0000-4000-8000-0000000000fe',
      submissionId: secondSubmission.submissionId,
      campaign_id: '99999999-9999-4999-8999-999999999999',
      utm_campaign: 'q2-retargeting',
    };

    await syncLead(
      { ...baseInput, submission: secondSubmission, acquisition: secondAcquisition },
      deps,
    );

    const contacts = provider.listAll('contacts');
    expect(contacts).toHaveLength(1);
    expect(contacts[0].properties.am_campaign_id).toBe(FIXTURE_ACQUISITION.campaign_id);
    expect(contacts[0].properties.am_utm_campaign).toBe('q1-neukunden');
    // The non-acquisition update did land.
    expect(contacts[0].properties.firstname).toBe('Nina Maria');
  });
});

describe('mapped property lists', () => {
  it('collects every contact property the mapping touches', () => {
    const props = mappedContactProperties(FIXTURE_MAPPING);
    expect(props).toContain('email');
    expect(props).toContain('am_person_id');
    expect(props).toContain('am_campaign_id');
    expect(props).toContain('vq_status');
    expect(new Set(props).size).toBe(props.length);
  });

  it('collects every deal property the mapping touches', () => {
    const props = mappedDealProperties(FIXTURE_MAPPING);
    expect(props).toContain('dealstage');
    expect(props).toContain('pipeline');
    expect(props).toContain('amount');
    expect(props).toContain('am_opportunity_id');
  });
});
