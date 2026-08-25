import { describe, expect, it } from 'vitest';
import { SALES_EVENT_TYPES } from '@am/domain';
import {
  FIXTURE_MAPPING,
  INCOMPLETE_FIXTURE_MAPPING,
  FIXTURE_MAPPING_ID,
} from '../fixtures';
import {
  MAPPING_WIZARD_STEPS,
  MAPPING_WIZARD_STEP_KEYS,
  REQUIRED_ACQUISITION_FIELD_KEYS,
  canPublishMapping,
  mappedEventCoverage,
  mappingDocumentSchema,
  missingRequiredMappings,
  publishMapping,
  requiredMappingsComplete,
  validateMapping,
} from './schema';

const NOW = '2026-03-01T12:00:00.000Z';
const EDITOR = '11111111-2222-4333-8444-555555555555';

describe('mapping wizard', () => {
  it('covers exactly the 15 wizard steps, in order', () => {
    expect(MAPPING_WIZARD_STEP_KEYS).toHaveLength(15);
    expect(MAPPING_WIZARD_STEPS.map((s) => s.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(new Set(MAPPING_WIZARD_STEPS.map((s) => s.key)).size).toBe(15);
  });

  it('parses a minimal draft and fills every section with defaults', () => {
    const draft = mappingDocumentSchema.parse({
      id: FIXTURE_MAPPING_ID,
      version: 1,
      createdAt: NOW,
    });
    expect(draft.dealCreation.trigger).toBe('VQ_SCHEDULED');
    expect(draft.company.mode).toBe('VERIFIED_CORPORATE_DOMAIN_ONLY');
    expect(draft.acquisition.writeOnce).toBe(true);
    expect(draft.status).toBe('DRAFT');
  });
});

describe('validateMapping', () => {
  it('accepts the fixture mapping without errors', () => {
    const result = validateMapping(FIXTURE_MAPPING);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports every missing required mapping in German', () => {
    const result = validateMapping(INCOMPLETE_FIXTURE_MAPPING);
    expect(result.ok).toBe(false);
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain('pipeline.pipelineId');
    expect(paths).toContain('pipeline.defaultStageId');
    expect(paths).toContain('revenue.amountProperty');
    for (const error of result.errors) {
      expect(error.messageDe.length).toBeGreaterThan(10);
      expect(error.messageDe).not.toMatch(/[a-z] (is|are|must) /);
    }
    expect(result.incompleteStepsDe).toContain('Pipeline');
  });

  it('flags a stage mapped to two different events', () => {
    const broken = {
      ...FIXTURE_MAPPING,
      stageEvents: [
        ...FIXTURE_MAPPING.stageEvents,
        {
          id: 'stage-duplicate',
          objectType: 'deals',
          pipelineId: null,
          stageId: 'closedwon',
          stageLabel: null,
          event: 'CLOSED_LOST' as const,
          terminal: false,
          occurredAtProperty: null,
        },
      ],
    };
    const result = validateMapping(broken);
    expect(result.errors.some((e) => e.code === 'DUPLICATE_RULE')).toBe(true);
    expect(canPublishMapping(broken)).toBe(false);
  });

  it('rejects an unknown acquisition slot', () => {
    const broken = {
      ...FIXTURE_MAPPING,
      acquisition: {
        ...FIXTURE_MAPPING.acquisition,
        contactProperties: {
          ...FIXTURE_MAPPING.acquisition.contactProperties,
          not_a_real_slot: 'am_whatever',
        },
      },
    };
    const result = validateMapping(broken);
    expect(result.errors.some((e) => e.code === 'UNKNOWN_ACQUISITION_SLOT')).toBe(true);
  });

  it('refuses a deal trigger no rule can ever produce', () => {
    const broken = {
      ...FIXTURE_MAPPING,
      dealCreation: { ...FIXTURE_MAPPING.dealCreation, trigger: 'REVENUE_RECOGNIZED' as const },
    };
    expect(validateMapping(broken).errors.some((e) => e.code === 'UNREACHABLE_TRIGGER')).toBe(true);
  });

  it('turns a schema violation into a German issue instead of throwing', () => {
    const result = validateMapping({ id: 'not-a-uuid', version: 0 });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('SCHEMA_INVALID');
    expect(result.errors[0].messageDe).toMatch(/Ungültiges Mapping/);
  });

  it('warns — but does not block — on a company rule that would create freemail companies', () => {
    const risky = { ...FIXTURE_MAPPING, company: { ...FIXTURE_MAPPING.company, mode: 'ALWAYS' as const } };
    const result = validateMapping(risky);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === 'FREEMAIL_COMPANY_RISK')).toBe(true);
  });
});

describe('requiredMappingsComplete — the launch gate', () => {
  it('blocks the launch until every required mapping exists', () => {
    expect(requiredMappingsComplete(INCOMPLETE_FIXTURE_MAPPING)).toBe(false);
    expect(missingRequiredMappings(INCOMPLETE_FIXTURE_MAPPING).length).toBeGreaterThan(0);

    expect(requiredMappingsComplete(FIXTURE_MAPPING)).toBe(true);
    expect(missingRequiredMappings(FIXTURE_MAPPING)).toEqual([]);
  });

  it('requires every acquisition slot that revenue attribution depends on', () => {
    for (const slot of REQUIRED_ACQUISITION_FIELD_KEYS) {
      const contactProperties = { ...FIXTURE_MAPPING.acquisition.contactProperties };
      const dealProperties = { ...FIXTURE_MAPPING.acquisition.dealProperties };
      delete contactProperties[slot];
      delete dealProperties[slot];
      const stripped = {
        ...FIXTURE_MAPPING,
        acquisition: { ...FIXTURE_MAPPING.acquisition, contactProperties, dealProperties },
      };
      expect(requiredMappingsComplete(stripped)).toBe(false);
    }
  });

  it('requires a form field that writes the contact identifier', () => {
    const stripped = {
      ...FIXTURE_MAPPING,
      formFieldMappings: FIXTURE_MAPPING.formFieldMappings.filter((f) => f.property !== 'email'),
    };
    const result = validateMapping(stripped);
    expect(result.errors.some((e) => e.code === 'NO_IDENTIFIER_FIELD')).toBe(true);
  });
});

describe('publishMapping', () => {
  it('freezes a new immutable version and leaves the draft untouched', () => {
    const draft = { ...FIXTURE_MAPPING, status: 'DRAFT' as const, publishedAt: null, publishedBy: null };
    const { document } = publishMapping(draft, { publishedBy: EDITOR, now: NOW, previousVersion: 4 });

    expect(document.version).toBe(5);
    expect(document.status).toBe('PUBLISHED');
    expect(document.publishedAt).toBe(NOW);
    expect(document.publishedBy).toBe(EDITOR);
    expect(draft.status).toBe('DRAFT');
    expect(draft.publishedAt).toBeNull();
  });

  it('refuses to publish a structurally broken document', () => {
    const broken = {
      ...FIXTURE_MAPPING,
      status: 'DRAFT' as const,
      propertyValueEvents: [
        {
          id: 'vq-rejected',
          objectType: 'contacts',
          property: 'vq_status',
          operator: 'EQUALS' as const,
          values: [],
          event: 'VQ_REJECTED' as const,
          once: false,
          occurredAtProperty: null,
        },
      ],
    };
    const { published, document, issues } = publishMapping(broken, {
      publishedBy: EDITOR,
      now: NOW,
    });
    expect(published).toBe(false);
    expect(document.status).toBe('DRAFT');
    expect(issues.every((i) => i.blocking === 'PUBLISH')).toBe(true);
  });

  it('still publishes a document that only misses launch-blocking data', () => {
    expect(canPublishMapping(INCOMPLETE_FIXTURE_MAPPING)).toBe(true);
    const { document } = publishMapping(INCOMPLETE_FIXTURE_MAPPING, {
      publishedBy: EDITOR,
      now: NOW,
    });
    expect(document.status).toBe('PUBLISHED');
    // …and the launch stays blocked.
    expect(requiredMappingsComplete(document)).toBe(false);
  });
});

describe('mappedEventCoverage', () => {
  it('reports coverage for all eleven canonical events', () => {
    const coverage = mappedEventCoverage(FIXTURE_MAPPING);
    expect(Object.keys(coverage).sort()).toEqual([...SALES_EVENT_TYPES].sort());
    expect(coverage.FORM_COMPLETED).toBe(true);
    expect(coverage.CLOSED_WON).toBe(true);
    expect(coverage.REVENUE_RECOGNIZED).toBe(false);
  });
});
