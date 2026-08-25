import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_CONFIDENCES,
  METRIC_CATALOG,
  METRIC_KEYS,
  ONCE_PER_OPPORTUNITY_STAGES,
  RETRY_POLICY,
  SALES_EVENT_TO_CAPI_STAGE,
  addMoney,
  attributionCoverage,
  capiEventIdSource,
  costPer,
  deriveConfidence,
  classifyAngleSimilarity,
  emailDomain,
  formatRateDe,
  initialLeadEventIdSource,
  isFreemailDomain,
  isTrustworthy,
  money,
  nextRetryDelayMs,
  normalizeEmail,
  normalizePhoneE164,
  postcodeDeSchema,
  rate,
  resolveConfidence,
  shouldDeadLetter,
  slugify,
} from './index';

describe('metric catalogue', () => {
  it('defines every key with a formula and a German label', () => {
    for (const key of METRIC_KEYS) {
      const metric = METRIC_CATALOG[key];
      expect(metric, key).toBeDefined();
      expect(metric.label.length, key).toBeGreaterThan(1);
      expect(metric.formula.length, key).toBeGreaterThan(1);
    }
  });

  it('marks CRM metrics as delayed and delivery metrics as immediate', () => {
    expect(METRIC_CATALOG.roas.latency).toBe('CRM_DELAYED');
    expect(METRIC_CATALOG.qualified_vq_rate.latency).toBe('CRM_DELAYED');
    expect(METRIC_CATALOG.ctr.latency).toBe('IMMEDIATE');
  });

  it('knows which direction is better', () => {
    expect(METRIC_CATALOG.cpl.direction).toBe('LOWER_IS_BETTER');
    expect(METRIC_CATALOG.roas.direction).toBe('HIGHER_IS_BETTER');
  });
});

describe('rates carry their basis', () => {
  it('keeps numerator and denominator', () => {
    const r = rate(12, 340);
    expect(r.numerator).toBe(12);
    expect(r.denominator).toBe(340);
    expect(r.value).toBeCloseTo(12 / 340);
  });

  it('returns null rather than zero for an empty denominator', () => {
    const r = rate(0, 0);
    expect(r.value).toBeNull();
    expect(formatRateDe(r)).toBe('–');
  });

  it('formats German percentages with a comma', () => {
    expect(formatRateDe(rate(1, 4))).toBe('25,0 %');
  });

  it('does the same for cost-per values', () => {
    expect(costPer(10_000, 0).value).toBeNull();
    expect(costPer(10_000, 4).value).toEqual({ amountMinor: 2500, currency: 'EUR' });
  });
});

describe('money', () => {
  it('rounds to whole minor units', () => {
    expect(money(10.6).amountMinor).toBe(11);
  });

  it('refuses to add across currencies', () => {
    expect(() => addMoney(money(100, 'EUR'), money(100, 'USD'))).toThrow();
  });
});

describe('contact primitives', () => {
  it('normalises e-mail without merging distinct addresses', () => {
    expect(normalizeEmail('  Max.Mustermann@Example.DE ')).toBe('max.mustermann@example.de');
    expect(normalizeEmail('a.b@gmail.com')).not.toBe(normalizeEmail('ab@gmail.com'));
  });

  it('normalises German phone formats to E.164', () => {
    expect(normalizePhoneE164('0170 1234567')).toBe('+491701234567');
    expect(normalizePhoneE164('+49 (170) 123-4567')).toBe('+491701234567');
    expect(normalizePhoneE164('0049 170 1234567')).toBe('+491701234567');
  });

  it('returns null rather than guessing on unusable input', () => {
    expect(normalizePhoneE164('abc')).toBeNull();
    expect(normalizePhoneE164('12')).toBeNull();
    expect(normalizePhoneE164('')).toBeNull();
  });

  it('recognises freemail domains', () => {
    expect(isFreemailDomain('gmx.de')).toBe(true);
    expect(isFreemailDomain('am-beratung.de')).toBe(false);
    expect(emailDomain('max@am-beratung.de')).toBe('am-beratung.de');
    expect(emailDomain('broken')).toBeNull();
  });

  it('validates German postcodes strictly', () => {
    expect(postcodeDeSchema.safeParse('10115').success).toBe(true);
    expect(postcodeDeSchema.safeParse('1011').success).toBe(false);
    expect(postcodeDeSchema.safeParse('101150').success).toBe(false);
    expect(postcodeDeSchema.safeParse('1011a').success).toBe(false);
  });

  it('slugifies German text', () => {
    expect(slugify('Kostenlose Potenzialanalyse für Geschäftsführer')).toBe(
      'kostenlose-potenzialanalyse-fuer-geschaeftsfuehrer',
    );
  });
});

describe('attribution confidence', () => {
  const signals = (over: Partial<Record<string, boolean>> = {}) => ({
    hasSignedToken: false,
    hasClickId: false,
    hasUniqueCampaignParam: false,
    hasGenericUtm: false,
    hasMetaReferrer: false,
    hasTemporalProximityOnly: false,
    ...over,
  });

  it('treats a signed token as exact', () => {
    expect(resolveConfidence(signals({ hasSignedToken: true }))).toBe('EXACT');
  });

  it('treats a click id as exact', () => {
    expect(resolveConfidence(signals({ hasClickId: true }))).toBe('EXACT');
  });

  it('never treats temporal proximity as exact', () => {
    expect(resolveConfidence(signals({ hasTemporalProximityOnly: true }))).toBe('LOW_CONFIDENCE');
  });

  it('grades UTM-only below UTM plus referrer', () => {
    expect(resolveConfidence(signals({ hasGenericUtm: true }))).toBe('MEDIUM_CONFIDENCE');
    expect(resolveConfidence(signals({ hasGenericUtm: true, hasMetaReferrer: true }))).toBe(
      'HIGH_CONFIDENCE',
    );
  });

  it('falls back to unknown with no signal', () => {
    expect(resolveConfidence(signals())).toBe('UNKNOWN');
  });

  it('counts only exact and high confidence as trustworthy', () => {
    const trusted = ATTRIBUTION_CONFIDENCES.filter(isTrustworthy);
    expect(trusted).toEqual(['EXACT', 'HIGH_CONFIDENCE']);
  });

  it('computes coverage as the trustworthy share', () => {
    expect(attributionCoverage(['EXACT', 'EXACT', 'UNKNOWN', 'LOW_CONFIDENCE'])).toBe(0.5);
    expect(attributionCoverage([])).toBeNull();
  });
});

describe('confidence derivation', () => {
  it('requires mature data and high coverage for a fact', () => {
    expect(deriveConfidence({ maturity: 'MATURE', attributionCoverage: 0.9, sampleSize: 30 })).toBe(
      'FACT',
    );
  });

  it('downgrades an immature cohort to a hypothesis regardless of coverage', () => {
    expect(
      deriveConfidence({ maturity: 'IMMATURE', attributionCoverage: 1, sampleSize: 500 }),
    ).toBe('HYPOTHESIS');
  });

  it('downgrades a mature but poorly attributed cohort', () => {
    expect(
      deriveConfidence({ maturity: 'MATURE', attributionCoverage: 0.55, sampleSize: 30 }),
    ).toBe('INDICATION');
  });

  it('downgrades a tiny sample', () => {
    expect(deriveConfidence({ maturity: 'MATURE', attributionCoverage: 1, sampleSize: 3 })).toBe(
      'HYPOTHESIS',
    );
  });
});

describe('angle distinctness', () => {
  it('blocks a near-duplicate angle', () => {
    expect(classifyAngleSimilarity(0.95)).toBe('TOO_SIMILAR');
  });

  it('labels a close angle an iteration', () => {
    expect(classifyAngleSimilarity(0.85)).toBe('ITERATION');
  });

  it('passes a genuinely different angle', () => {
    expect(classifyAngleSimilarity(0.4)).toBe('DISTINCT');
  });
});

describe('outbox semantics', () => {
  it('derives one shared event id for the pixel/CAPI pair', () => {
    expect(initialLeadEventIdSource('sub-1')).toBe('lead:sub-1');
    expect(initialLeadEventIdSource('sub-1')).toBe(initialLeadEventIdSource('sub-1'));
  });

  it('derives a deterministic down-funnel event id per transition', () => {
    expect(capiEventIdSource('fi-1', 'VQ_SCHEDULED', 1)).toBe('fi-1:VQ_SCHEDULED:1');
    expect(capiEventIdSource('fi-1', 'VQ_SCHEDULED', 2)).not.toBe(
      capiEventIdSource('fi-1', 'VQ_SCHEDULED', 1),
    );
  });

  it('backs off exponentially within the cap', () => {
    const a = nextRetryDelayMs(1, 0);
    const b = nextRetryDelayMs(3, 0);
    expect(b).toBeGreaterThan(a);
    expect(nextRetryDelayMs(50, 0)).toBeLessThanOrEqual(RETRY_POLICY.maxDelayMs * 1.2);
  });

  it('is deterministic for the same attempt and seed', () => {
    expect(nextRetryDelayMs(4, 12345)).toBe(nextRetryDelayMs(4, 12345));
  });

  it('dead-letters at the attempt limit', () => {
    expect(shouldDeadLetter(RETRY_POLICY.maxAttempts - 1)).toBe(false);
    expect(shouldDeadLetter(RETRY_POLICY.maxAttempts)).toBe(true);
  });
});

describe('CAPI stage mapping', () => {
  it('maps the initial lead and the closed-won conversion', () => {
    expect(SALES_EVENT_TO_CAPI_STAGE.FORM_COMPLETED).toBe('INITIAL_LEAD');
    expect(SALES_EVENT_TO_CAPI_STAGE.CLOSED_WON).toBe('CONVERTED');
  });

  it('has no Meta counterpart for internal-only events', () => {
    expect(SALES_EVENT_TO_CAPI_STAGE.VQ_NO_SHOW).toBeUndefined();
    expect(SALES_EVENT_TO_CAPI_STAGE.CLOSED_LOST).toBeUndefined();
  });

  it('marks CONVERTED as once per opportunity', () => {
    expect(ONCE_PER_OPPORTUNITY_STAGES).toEqual(['CONVERTED']);
  });
});
