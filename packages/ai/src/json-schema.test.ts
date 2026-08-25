import { creativeConceptSchema, isDomainError } from '@am/domain';
import { describe, expect, it } from 'vitest';
import {
  findStrictSchemaViolations,
  toResponseFormat,
  toSchemaName,
  zodToStrictJsonSchema,
} from './json-schema';
import { campaignPackageSchema, funnelSpecDraftSchema } from './prompts/schemas';
import { ALL_PROMPTS } from './prompts/registry';
import { z } from 'zod';

const nested = z.object({
  title: z.string().min(3).max(80),
  score: z.number().int().min(0).max(100).nullable().default(null),
  optionalNote: z.string().max(200).optional(),
  tags: z.array(z.string().min(2)).min(1).max(5).default([]),
  children: z
    .array(
      z.object({
        key: z.string().regex(/^child_[1-9]$/),
        kind: z.enum(['A', 'B']),
        payload: z.object({ label: z.string(), value: z.number().nullable() }).nullable(),
      }),
    )
    .max(3),
});

describe('zodToStrictJsonSchema', () => {
  const schema = zodToStrictJsonSchema(nested);

  it('emits a strict object root', () => {
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$schema).toBeUndefined();
  });

  it('marks every property required, including defaults and optionals', () => {
    expect(schema.required).toEqual([
      'title',
      'score',
      'optionalNote',
      'tags',
      'children',
    ]);
  });

  it('keeps nullables as an explicit null branch and drops the default keyword', () => {
    const score = (schema.properties as Record<string, Record<string, unknown>>).score!;
    expect(score.anyOf).toEqual([
      { type: 'integer', description: expect.stringContaining('>=') },
      { type: 'null' },
    ]);
    expect(score.default).toBeUndefined();
  });

  it('recurses into arrays and nested nullable objects', () => {
    const children = (schema.properties as Record<string, Record<string, unknown>>).children!;
    const item = children.items as Record<string, unknown>;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['key', 'kind', 'payload']);

    const payload = (item.properties as Record<string, Record<string, unknown>>).payload!;
    const objectBranch = (payload.anyOf as Record<string, unknown>[])[0]!;
    expect(objectBranch.additionalProperties).toBe(false);
    expect(objectBranch.required).toEqual(['label', 'value']);
  });

  it('moves range and pattern constraints into the description', () => {
    const title = (schema.properties as Record<string, Record<string, unknown>>).title!;
    expect(title).toEqual({
      type: 'string',
      description: 'Constraints: min. 3 characters, max. 80 characters.',
    });
    expect(title.minLength).toBeUndefined();
  });

  it('can keep the constraint keywords when asked', () => {
    const kept = zodToStrictJsonSchema(nested, { constraintMode: 'keep' });
    const title = (kept.properties as Record<string, Record<string, unknown>>).title!;
    expect(title.minLength).toBe(3);
    expect(title.maxLength).toBe(80);
  });

  it('produces no strict-subset violations', () => {
    expect(findStrictSchemaViolations(schema)).toEqual([]);
  });

  it('rejects shapes the strict subset cannot express', () => {
    expect(() => zodToStrictJsonSchema(z.object({ bag: z.record(z.string(), z.number()) }))).toThrow(
      /striktes JSON-Schema/,
    );
    expect(() => zodToStrictJsonSchema(z.object({ anything: z.unknown() }))).toThrow();

    try {
      zodToStrictJsonSchema(z.array(z.string()) as unknown as z.ZodType);
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
    }
  });
});

describe('domain and prompt schemas convert cleanly', () => {
  it.each([
    ['creativeConcept', creativeConceptSchema],
    ['funnelSpecDraft', funnelSpecDraftSchema],
    ['campaignPackage', campaignPackageSchema],
  ])('%s satisfies the strict subset', (_name, schema) => {
    expect(findStrictSchemaViolations(zodToStrictJsonSchema(schema))).toEqual([]);
  });

  it('every registered prompt emits a valid response format', () => {
    for (const prompt of ALL_PROMPTS) {
      const format = toResponseFormat(prompt.id, prompt.outputSchema);
      expect(format.type).toBe('json_schema');
      expect(format.strict).toBe(true);
      expect(format.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(findStrictSchemaViolations(format.schema)).toEqual([]);
    }
  });
});

describe('toSchemaName', () => {
  it('sanitises ids into the allowed character set', () => {
    expect(toSchemaName('context.summarize')).toBe('context_summarize');
    expect(toSchemaName('a'.repeat(80))).toHaveLength(64);
    expect(toSchemaName('!!!')).toBe('structured_output');
  });
});
