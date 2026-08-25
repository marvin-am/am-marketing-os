import { DomainError } from '@am/domain';
import { z } from 'zod';

/**
 * Zod → strict JSON Schema for the OpenAI Responses API Structured Outputs
 * format (`text.format = { type: 'json_schema', strict: true, … }`).
 *
 * The API's strict subset is narrower than JSON Schema:
 *
 * - the root must be an object,
 * - every object must set `additionalProperties: false`,
 * - every declared property must appear in `required` — there is no optionality,
 * - open shapes (`z.unknown()`, `z.record()`) cannot be expressed at all.
 *
 * Optionality is therefore folded away rather than emitted:
 *
 * - `.default(x)` — the `default` keyword is dropped and the property becomes
 *   required. The model always emits a value, which the Zod schema accepts.
 * - `.nullable()` — kept as `anyOf: [T, { type: 'null' }]` and required, so the
 *   model can still express "no value" without breaking the strict contract.
 * - `.optional()` — required in the JSON Schema. A present value is always
 *   valid input for an optional Zod field, so this narrows without conflicting.
 *
 * Range and pattern keywords are, by default, moved into the property
 * description instead of being emitted (`constraintMode: 'describe'`). The
 * strict subset has historically rejected several of them, and the published
 * API reference was not reachable from this build environment, so the library
 * defaults to the shape that cannot produce a 400. The Zod schema still
 * enforces every constraint when the response is parsed — the JSON Schema is a
 * generation guide, never the validation authority.
 */

export type ConstraintMode = 'describe' | 'keep';

export interface StrictJsonSchemaOptions {
  /** What to do with range/pattern keywords. Defaults to `'describe'`. */
  constraintMode?: ConstraintMode;
}

export type JsonSchemaObject = Record<string, unknown>;

/** Keywords the strict subset is guaranteed to accept. */
const STRUCTURAL_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'enum',
  'const',
  'description',
  'title',
]);

/** Range / pattern keywords, in the order they should read in a description. */
const CONSTRAINT_KEYWORDS = [
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const;

type ConstraintKeyword = (typeof CONSTRAINT_KEYWORDS)[number];

const CONSTRAINT_KEYWORD_SET = new Set<string>(CONSTRAINT_KEYWORDS);

const HINT_TEXT: Record<ConstraintKeyword, (value: unknown) => string> = {
  format: (v) => `format ${String(v)}`,
  pattern: (v) => {
    const source = String(v);
    // A generated regex (uuid, date-time) is longer than the copy it guards and
    // would swamp the instruction the model actually needs to read.
    return source.length > 60 ? 'must match a fixed pattern' : `must match /${source}/`;
  },
  minLength: (v) => `min. ${String(v)} characters`,
  maxLength: (v) => `max. ${String(v)} characters`,
  minimum: (v) => `>= ${String(v)}`,
  maximum: (v) => `<= ${String(v)}`,
  exclusiveMinimum: (v) => `> ${String(v)}`,
  exclusiveMaximum: (v) => `< ${String(v)}`,
  multipleOf: (v) => `multiple of ${String(v)}`,
  minItems: (v) => `min. ${String(v)} entries`,
  maxItems: (v) => `max. ${String(v)} entries`,
  uniqueItems: () => 'entries must be unique',
};

function renderHints(found: Partial<Record<ConstraintKeyword, unknown>>): string[] {
  const hints: string[] = [];
  for (const keyword of CONSTRAINT_KEYWORDS) {
    if (!(keyword in found)) continue;
    // `format` already says everything the generated pattern would.
    if (keyword === 'pattern' && 'format' in found) continue;
    hints.push(HINT_TEXT[keyword](found[keyword]));
  }
  return hints;
}

const DROPPED_KEYWORDS = new Set(['$schema', 'default', 'id', '$id', 'examples', 'deprecated']);

function fail(message: string, path: string): never {
  throw new DomainError('VALIDATION_FAILED', {
    messageDe: 'Das Ausgabeschema lässt sich nicht in ein striktes JSON-Schema übersetzen.',
    details: { path, reason: message },
  });
}

function isPlainObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withHints(node: JsonSchemaObject, hints: string[]): void {
  if (hints.length === 0) return;
  const existing = typeof node.description === 'string' ? node.description.trim() : '';
  const suffix = `Constraints: ${hints.join(', ')}.`;
  node.description = existing.length > 0 ? `${existing} ${suffix}` : suffix;
}

function transform(node: unknown, path: string, mode: ConstraintMode): JsonSchemaObject {
  if (!isPlainObject(node)) fail('expected a schema object', path);

  const result: JsonSchemaObject = {};
  const found: Partial<Record<ConstraintKeyword, unknown>> = {};

  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYWORDS.has(key)) continue;

    if (CONSTRAINT_KEYWORD_SET.has(key)) {
      if (mode === 'keep') {
        result[key] = value;
      } else {
        found[key as ConstraintKeyword] = value;
      }
      continue;
    }

    if (!STRUCTURAL_KEYWORDS.has(key)) {
      if (key === 'propertyNames' || key === 'patternProperties') {
        fail(
          'open record shapes cannot be expressed in the strict subset — model an explicit object instead',
          path,
        );
      }
      // Unknown keyword: dropping is safer than forwarding something the API
      // may reject outright.
      continue;
    }

    result[key] = value;
  }

  if (result.anyOf !== undefined) {
    if (!Array.isArray(result.anyOf)) fail('anyOf must be an array', path);
    result.anyOf = result.anyOf.map((branch, index) =>
      transform(branch, `${path}/anyOf/${index}`, mode),
    );
  }

  if (result.type === 'array') {
    if (result.items === undefined) fail('arrays require an `items` schema', path);
    result.items = transform(result.items, `${path}/items`, mode);
  }

  if (result.type === 'object') {
    const properties = result.properties;
    if (!isPlainObject(properties)) {
      fail('objects require an explicit `properties` map', path);
    }
    if (typeof node.additionalProperties === 'object' && node.additionalProperties !== null) {
      fail(
        'open record shapes cannot be expressed in the strict subset — model an explicit object instead',
        path,
      );
    }

    const nextProperties: JsonSchemaObject = {};
    for (const [key, child] of Object.entries(properties)) {
      nextProperties[key] = transform(child, `${path}/properties/${key}`, mode);
    }
    result.properties = nextProperties;
    // Strict mode has no optionality: every declared property is required.
    result.required = Object.keys(nextProperties);
    result.additionalProperties = false;
  }

  if (
    result.type === undefined &&
    result.anyOf === undefined &&
    result.enum === undefined &&
    result.const === undefined
  ) {
    fail(
      'unconstrained schemas (z.unknown / z.any) are not expressible — declare an explicit shape',
      path,
    );
  }

  withHints(result, renderHints(found));
  return result;
}

/**
 * Converts a Zod schema into the strict JSON Schema object accepted by the
 * Responses API. The result is the value for `text.format.schema`.
 */
export function zodToStrictJsonSchema(
  schema: z.ZodType,
  options: StrictJsonSchemaOptions = {},
): JsonSchemaObject {
  const mode = options.constraintMode ?? 'describe';

  let raw: unknown;
  try {
    raw = z.toJSONSchema(schema, {
      io: 'input',
      target: 'draft-2020-12',
      reused: 'inline',
      unrepresentable: 'any',
    });
  } catch (cause) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Das Ausgabeschema lässt sich nicht in ein striktes JSON-Schema übersetzen.',
      cause,
    });
  }

  const converted = transform(raw, '#', mode);
  if (converted.type !== 'object') {
    fail('the root of a structured output schema must be an object', '#');
  }
  return converted;
}

/** Response-format name: `a-z A-Z 0-9 _ -`, at most 64 characters. */
export function toSchemaName(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned.length > 0 ? cleaned : 'structured_output').slice(0, 64);
}

export interface StrictResponseFormat {
  type: 'json_schema';
  name: string;
  schema: JsonSchemaObject;
  strict: true;
  description?: string;
}

/** Builds the complete `text.format` payload for a Responses API call. */
export function toResponseFormat(
  name: string,
  schema: z.ZodType,
  options: StrictJsonSchemaOptions & { description?: string } = {},
): StrictResponseFormat {
  const format: StrictResponseFormat = {
    type: 'json_schema',
    name: toSchemaName(name),
    schema: zodToStrictJsonSchema(schema, options),
    strict: true,
  };
  if (options.description) format.description = options.description;
  return format;
}

/**
 * Structural self-check used by tests and by the prompt registry: verifies that
 * a converted schema really does satisfy the strict subset.
 */
export function findStrictSchemaViolations(node: unknown, path = '#'): string[] {
  const violations: string[] = [];
  if (!isPlainObject(node)) return [`${path}: not an object`];

  for (const key of Object.keys(node)) {
    if (!STRUCTURAL_KEYWORDS.has(key)) violations.push(`${path}: unsupported keyword "${key}"`);
  }

  if (node.type === 'object') {
    if (node.additionalProperties !== false) {
      violations.push(`${path}: additionalProperties must be false`);
    }
    const properties = isPlainObject(node.properties) ? node.properties : {};
    const required = Array.isArray(node.required) ? node.required.map(String) : [];
    const declared = Object.keys(properties);
    for (const key of declared) {
      if (!required.includes(key)) violations.push(`${path}: "${key}" missing from required`);
      violations.push(...findStrictSchemaViolations(properties[key], `${path}/${key}`));
    }
    for (const key of required) {
      if (!declared.includes(key)) violations.push(`${path}: required lists unknown "${key}"`);
    }
  }

  if (node.type === 'array') {
    violations.push(...findStrictSchemaViolations(node.items, `${path}[]`));
  }

  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((branch, index) => {
      violations.push(...findStrictSchemaViolations(branch, `${path}|${index}`));
    });
  }

  return violations;
}
