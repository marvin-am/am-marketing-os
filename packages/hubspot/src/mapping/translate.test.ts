import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ACQUISITION,
  FIXTURE_FREEMAIL_SUBMISSION,
  FIXTURE_MAPPING,
  FIXTURE_SUBMISSION,
} from '../fixtures';
import type { ObjectSnapshot } from '../types';
import {
  amountToMinor,
  evaluateCondition,
  isVerifiedCorporateDomain,
  parseHubspotTimestamp,
  renderDealName,
  resolveVqEvaluation,
  shouldCreateCompany,
  shouldCreateDeal,
  toCanonicalEvents,
  toContactProperties,
  toDealProperties,
  vqModelVersion,
} from './translate';

const OBSERVED_AT = '2026-02-10T08:00:00.000Z';

function dealSnapshot(stage: string, extra: Record<string, string> = {}): ObjectSnapshot {
  return {
    objectType: 'deals',
    objectId: '7001',
    properties: {
      pipeline: 'default',
      dealstage: stage,
      amount: '12500.00',
      deal_currency_code: 'EUR',
      ...extra,
    },
    observedAt: OBSERVED_AT,
  };
}

describe('toCanonicalEvents — acceptance criterion 32', () => {
  it('emits nothing when a repeated sync observes the same stage', () => {
    const snapshot = dealSnapshot('qualifiedtobuy');
    const events = toCanonicalEvents({
      before: snapshot,
      after: { ...snapshot, observedAt: '2026-02-10T09:00:00.000Z' },
      mapping: FIXTURE_MAPPING,
    });
    expect(events).toEqual([]);
  });

  it('emits nothing for ten identical re-syncs in a row', () => {
    const snapshot = dealSnapshot('qualifiedtobuy');
    for (let i = 0; i < 10; i += 1) {
      expect(
        toCanonicalEvents({ before: snapshot, after: snapshot, mapping: FIXTURE_MAPPING }),
      ).toEqual([]);
    }
  });

  it('emits exactly one event on a real stage transition', () => {
    const events = toCanonicalEvents({
      before: dealSnapshot('appointmentscheduled'),
      after: dealSnapshot('qualifiedtobuy'),
      mapping: FIXTURE_MAPPING,
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('VQ_PASSED');
    expect(events[0].previousState).toBe('appointmentscheduled');
    expect(events[0].newState).toBe('qualifiedtobuy');
    expect(events[0].ruleId).toBe('stage-qualified');
    expect(events[0].mappingVersion).toBe(FIXTURE_MAPPING.version);
  });

  it('treats the first observation as a transition from null', () => {
    const events = toCanonicalEvents({
      before: null,
      after: dealSnapshot('appointmentscheduled'),
      mapping: FIXTURE_MAPPING,
    });
    expect(events.map((e) => e.type)).toEqual(['VQ_SCHEDULED']);
    expect(events[0].previousState).toBeNull();
  });

  it('carries the revenue amount in minor units on CLOSED_WON', () => {
    const events = toCanonicalEvents({
      before: dealSnapshot('contractsent'),
      after: dealSnapshot('closedwon', { closedate: '2026-02-11T00:00:00.000Z' }),
      mapping: FIXTURE_MAPPING,
    });
    const won = events.find((e) => e.type === 'CLOSED_WON');
    expect(won?.amountMinor).toBe(1_250_000);
    expect(won?.currency).toBe('EUR');
    expect(won?.occurredAt).toBe('2026-02-11T00:00:00.000Z');

    const recognized = events.find((e) => e.type === 'REVENUE_RECOGNIZED');
    expect(recognized?.amountMinor).toBe(1_250_000);
  });

  it('does not re-emit a terminal event that was already recorded', () => {
    const events = toCanonicalEvents({
      before: dealSnapshot('closedwon'),
      after: dealSnapshot('contractsent'),
      mapping: FIXTURE_MAPPING,
      emittedEventTypes: ['SALES_ACCEPTED', 'CLOSED_WON'],
    });
    expect(events).toEqual([]);
  });

  it('emits on a property value transition, but not while the value stays put', () => {
    const before: ObjectSnapshot = {
      objectType: 'contacts',
      objectId: '801',
      properties: { vq_status: 'terminiert' },
      observedAt: OBSERVED_AT,
    };
    const after: ObjectSnapshot = { ...before, properties: { vq_status: 'abgelehnt' } };

    const first = toCanonicalEvents({ before, after, mapping: FIXTURE_MAPPING });
    expect(first.map((e) => e.type)).toEqual(['VQ_REJECTED']);

    const repeat = toCanonicalEvents({ before: after, after, mapping: FIXTURE_MAPPING });
    expect(repeat).toEqual([]);
  });

  it('recognises a no-show through the mapped property', () => {
    const before: ObjectSnapshot = {
      objectType: 'contacts',
      objectId: '802',
      properties: { vq_status: 'terminiert' },
      observedAt: OBSERVED_AT,
    };
    const events = toCanonicalEvents({
      before,
      after: { ...before, properties: { vq_status: 'nicht_erschienen' } },
      mapping: FIXTURE_MAPPING,
    });
    expect(events.map((e) => e.type)).toEqual(['VQ_NO_SHOW']);
  });

  it('gives a repeated webhook the same dedupe key and a later transition its own', () => {
    const a = toCanonicalEvents({
      before: dealSnapshot('appointmentscheduled'),
      after: dealSnapshot('qualifiedtobuy'),
      mapping: FIXTURE_MAPPING,
    });
    const b = toCanonicalEvents({
      before: dealSnapshot('appointmentscheduled'),
      after: dealSnapshot('qualifiedtobuy'),
      mapping: FIXTURE_MAPPING,
    });
    expect(a[0].dedupeKey).toBe(b[0].dedupeKey);
    expect(a[0].dedupeKey).not.toContain('undefined');
  });
});

describe('company rules', () => {
  it('creates a company for a verified corporate domain', () => {
    expect(isVerifiedCorporateDomain(FIXTURE_SUBMISSION.email, FIXTURE_MAPPING)).toBe(true);
    expect(shouldCreateCompany(FIXTURE_SUBMISSION.email, FIXTURE_MAPPING)).toBe(true);
  });

  it('never creates a company for a freemail domain', () => {
    expect(isVerifiedCorporateDomain(FIXTURE_FREEMAIL_SUBMISSION.email, FIXTURE_MAPPING)).toBe(false);
    expect(shouldCreateCompany(FIXTURE_FREEMAIL_SUBMISSION.email, FIXTURE_MAPPING)).toBe(false);
  });

  it('honours portal-specific extra freemail domains', () => {
    const mapping = {
      ...FIXTURE_MAPPING,
      company: { ...FIXTURE_MAPPING.company, additionalFreemailDomains: ['beispiel-gmbh.de'] },
    };
    expect(shouldCreateCompany(FIXTURE_SUBMISSION.email, mapping)).toBe(false);
  });

  it('respects the NEVER mode even for a corporate domain', () => {
    const mapping = { ...FIXTURE_MAPPING, company: { ...FIXTURE_MAPPING.company, mode: 'NEVER' as const } };
    expect(shouldCreateCompany(FIXTURE_SUBMISSION.email, mapping)).toBe(false);
  });
});

describe('write payloads', () => {
  it('builds contact properties from mapped fields only', () => {
    const props = toContactProperties(FIXTURE_SUBMISSION, FIXTURE_MAPPING, {
      acquisition: FIXTURE_ACQUISITION,
    });
    expect(props.email).toBe('nina.weber@beispiel-gmbh.de');
    expect(props.firstname).toBe('Nina');
    expect(props.phone).toBe('+491701234567');
    expect(props.am_person_id).toBe(FIXTURE_SUBMISSION.personId);
    expect(props.am_campaign_id).toBe(FIXTURE_ACQUISITION.campaign_id);
    expect(props.am_utm_source).toBe('facebook');
    // An unmapped answer is never guessed into a property.
    expect(props.budget_range).toBeUndefined();
  });

  it('omits create-only fields on a later touch', () => {
    const first = toContactProperties(FIXTURE_SUBMISSION, FIXTURE_MAPPING, {
      includeCreateOnly: true,
    });
    const later = toContactProperties(FIXTURE_SUBMISSION, FIXTURE_MAPPING, {
      includeCreateOnly: false,
    });
    expect(first.lifecyclestage).toBe('lead');
    expect(later.lifecyclestage).toBeUndefined();
  });

  it('marks a test lead through the mapped marker property', () => {
    const props = toContactProperties(
      { ...FIXTURE_SUBMISSION, isTestLead: true },
      FIXTURE_MAPPING,
    );
    expect(props.am_test_record).toBe('AM_TEST_LEAD');
  });

  it('builds deal properties including pipeline, stage and identity', () => {
    const props = toDealProperties({
      submission: FIXTURE_SUBMISSION,
      mapping: FIXTURE_MAPPING,
      amOpportunityId: 'opp-1',
      acquisition: FIXTURE_ACQUISITION,
      amountMinor: 1_250_000,
      currency: 'EUR',
      campaignLabel: 'Q1 Neukunden',
    });
    expect(props.pipeline).toBe('default');
    expect(props.dealstage).toBe('appointmentscheduled');
    expect(props.am_opportunity_id).toBe('opp-1');
    expect(props.am_submission_id).toBe(FIXTURE_SUBMISSION.submissionId);
    expect(props.dealname).toBe('Nina Weber – Q1 Neukunden');
    expect(props.amount).toBe('12500.00');
    expect(props.deal_currency_code).toBe('EUR');
  });

  it('renders a deal name without leaving dangling separators', () => {
    expect(renderDealName('{{fullName}} – {{campaign}}', { fullName: 'A B', campaign: null })).toBe(
      'A B',
    );
    expect(renderDealName('{{fullName}}', {})).toBe('Lead');
  });

  it('creates a deal only for the mapped trigger', () => {
    expect(shouldCreateDeal(FIXTURE_MAPPING, 'FORM_COMPLETED')).toBe(false);
    expect(shouldCreateDeal(FIXTURE_MAPPING, 'VQ_SCHEDULED')).toBe(true);
  });
});

describe('resolveVqEvaluation', () => {
  const properties = {
    vq_status: 'qualifiziert',
    vq_score: '82',
    vq_reason_codes: 'BUDGET_OK;ZEITRAUM_OK',
  };

  it('is reproducible for identical input', () => {
    const a = resolveVqEvaluation(properties, FIXTURE_MAPPING, { now: OBSERVED_AT });
    const b = resolveVqEvaluation(properties, FIXTURE_MAPPING, { now: OBSERVED_AT });
    expect(a).toEqual(b);
    expect(a.vq_status).toBe('PASSED');
    expect(a.vq_score).toBe(82);
    expect(a.vq_reason_codes).toEqual(['BUDGET_OK', 'ZEITRAUM_OK']);
    expect(a.vq_model_version).toBe(vqModelVersion(FIXTURE_MAPPING));
    expect(a.vq_evaluated_at).toBe(OBSERVED_AT);
  });

  it('normalises a portal-specific score scale onto 0..100', () => {
    const mapping = { ...FIXTURE_MAPPING, vq: { ...FIXTURE_MAPPING.vq, scoreMin: 0, scoreMax: 10 } };
    const result = resolveVqEvaluation({ vq_score: '7' }, mapping, { now: OBSERVED_AT });
    expect(result.vq_score).toBe(70);
  });

  it('records a reason code instead of guessing when the value is unmapped', () => {
    const result = resolveVqEvaluation({ vq_status: 'irgendwas' }, FIXTURE_MAPPING, {
      now: OBSERVED_AT,
    });
    expect(result.vq_status).toBe('NOT_SCHEDULED');
    expect(result.vq_reason_codes).toContain('VQ_STATUS_UNMAPPED');
  });

  it('derives REJECTED from a disqualifying lost reason', () => {
    const result = resolveVqEvaluation(
      { closed_lost_reason: 'Nicht qualifiziert' },
      FIXTURE_MAPPING,
      { now: OBSERVED_AT },
    );
    expect(result.vq_status).toBe('REJECTED');
    expect(result.vq_reason_codes).toContain('DISQUALIFIED');
  });
});

describe('primitive helpers', () => {
  it('converts amounts to integer minor units', () => {
    expect(amountToMinor('1500.00', 'MAJOR')).toBe(150_000);
    expect(amountToMinor('1.005', 'MAJOR')).toBe(101);
    expect(amountToMinor('150000', 'MINOR')).toBe(150_000);
    expect(amountToMinor('1.234,56', 'MAJOR')).toBe(123_456);
    expect(amountToMinor('1,500.00', 'MAJOR')).toBe(150_000);
    expect(amountToMinor('-250.5', 'MAJOR')).toBe(-25_050);
    expect(amountToMinor(null, 'MAJOR')).toBeNull();
    expect(amountToMinor('keine Zahl', 'MAJOR')).toBeNull();
  });

  it('parses ISO and epoch timestamps', () => {
    expect(parseHubspotTimestamp('2026-02-10T08:00:00.000Z')).toBe('2026-02-10T08:00:00.000Z');
    expect(parseHubspotTimestamp('1770710400000')).toBe(new Date(1770710400000).toISOString());
    expect(parseHubspotTimestamp(null)).toBeNull();
  });

  it('evaluates every condition operator', () => {
    expect(evaluateCondition('A', 'EQUALS', ['a'])).toBe(true);
    expect(evaluateCondition('A', 'NOT_EQUALS', ['a'])).toBe(false);
    expect(evaluateCondition(null, 'IS_EMPTY', [])).toBe(true);
    expect(evaluateCondition('x', 'IS_NOT_EMPTY', [])).toBe(true);
    expect(evaluateCondition('5', 'GREATER_THAN', ['3'])).toBe(true);
    expect(evaluateCondition('5', 'LESS_THAN', ['3'])).toBe(false);
    expect(evaluateCondition('b', 'IN', ['a', 'b'])).toBe(true);
    expect(evaluateCondition('c', 'NOT_IN', ['a', 'b'])).toBe(true);
  });
});
