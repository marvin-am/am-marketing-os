import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FORBIDDEN_EVENT_KEYS_EXACT,
  FORBIDDEN_EVENT_KEY_FRAGMENTS,
  findPiiViolations,
  isForbiddenEventKey,
} from '@am/domain';
import {
  announceSkip,
  HAS_DATABASE,
  setupDatabase,
  type Harness,
} from '../../../supabase/tests/harness';

/**
 * The PII guard exists twice and must not drift.
 *
 * `@am/domain` guards the collector route; `app.jsonb_pii_violations` guards the
 * RPC, which a direct PostgREST call reaches without going through the route at
 * all. Two implementations of one rule is a standing invitation to the failure
 * that already happened once in this repository between `@am/meta` and
 * `@am/tracking` — the launch token parameter drifted, nothing failed loudly,
 * and every lead silently lost its attribution.
 *
 * The drift here would be quieter still: the SQL list falls behind, an event
 * carrying a lead's phone number is refused by the route and accepted by the
 * RPC, and nothing anywhere reports a problem.
 *
 * The list comparison runs everywhere. The behavioural comparison needs Postgres
 * and skips cleanly without it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, '..', '..', '..', 'supabase', 'migrations', '0017_harden_privileges.sql');

/** Reads one `array[ … ]` literal out of the migration by its leading entry. */
function sqlArrayAfter(source: string, firstEntry: string): string[] {
  const start = source.indexOf(`'${firstEntry}'`);
  if (start === -1) throw new Error(`No SQL array starting with '${firstEntry}' in 0017.`);
  const end = source.indexOf(']', start);
  return Array.from(source.slice(start, end).matchAll(/'([a-z]+)'/g)).map((match) => match[1] as string);
}

/**
 * Values that are personal data, and values that only look like it. The second
 * group matters as much as the first: a guard that rejects `content_name` or a
 * Meta object id gets switched off, and then it guards nothing.
 */
const CORPUS: readonly { label: string; payload: unknown; pii: boolean }[] = [
  { label: 'e-mail under a forbidden key', payload: { metadata: { email: 'max@example.de' } }, pii: true },
  { label: 'e-mail under an innocent key', payload: { metadata: { hinweis: 'max@example.de' } }, pii: true },
  { label: 'percent-encoded e-mail', payload: { metadata: { v: 'max%40example.de' } }, pii: true },
  { label: 'e-mail in a landing url', payload: { landing_url: 'https://x.de/f?e=max@example.de' }, pii: true },
  { label: 'international phone', payload: { metadata: { v: '+49 151 23456789' } }, pii: true },
  { label: 'phone with 00 prefix', payload: { metadata: { v: '0049 151 23456789' } }, pii: true },
  { label: 'german national phone', payload: { metadata: { v: '0151 23456789' } }, pii: true },
  { label: 'phone with a slash', payload: { metadata: { v: '030/12345678' } }, pii: true },
  { label: 'phone in prose', payload: { metadata: { v: 'Rückruf unter 0151 23456789' } }, pii: true },
  { label: 'bare DACH number', payload: { metadata: { v: '4915123456789' } }, pii: true },
  { label: 'phone_number key', payload: { metadata: { phone_number: 'x' } }, pii: true },
  { label: 'camelCase key', payload: { metadata: { emailAddress: 'x' } }, pii: true },
  { label: 'answers blob', payload: { metadata: { answers: { q1: 'ja' } } }, pii: true },
  { label: 'nested in an array', payload: { metadata: { list: [{ vorname: 'Max' }] } }, pii: true },

  { label: 'meta content_name', payload: { metadata: { content_name: 'Potenzialanalyse' } }, pii: false },
  { label: 'campaign_name', payload: { metadata: { campaign_name: 'Q3 Handwerk' } }, pii: false },
  { label: 'event_name', payload: { metadata: { event_name: 'Lead' } }, pii: false },
  { label: 'meta object id', payload: { meta_campaign_id: '120210000000000000' }, pii: false },
  { label: 'meta adset id', payload: { meta_adset_id: '23851234567890123' }, pii: false },
  { label: 'uuid', payload: { visitor_id: '00123456-7890-4abc-8def-000111222333' }, pii: false },
  { label: 'iso timestamp', payload: { occurred_at: '2026-03-01T10:00:00.000Z' }, pii: false },
  { label: 'minor-unit amount', payload: { metadata: { spend_minor: 8867200 } }, pii: false },
  { label: 'step index', payload: { metadata: { step_index: 3, elapsed_ms: 42 } }, pii: false },
  { label: 'utm parameters', payload: { utm_source: 'facebook', utm_campaign: 'potenzialanalyse-q1' }, pii: false },
  { label: 'viewport bucket', payload: { metadata: { viewport_bucket: 'md' } }, pii: false },
  { label: 'consent status', payload: { consent_status: 'GRANTED' }, pii: false },
];

if (!HAS_DATABASE) announceSkip('packages/db/integration/pii-guard-parity.test.ts');

describe('PII guard lists', () => {
  const migration = readFileSync(MIGRATION, 'utf8');

  it('carries the same exact-match keys as @am/domain', () => {
    expect(sqlArrayAfter(migration, 'name')).toEqual([...FORBIDDEN_EVENT_KEYS_EXACT]);
  });

  it('carries the same substring fragments as @am/domain', () => {
    expect(sqlArrayAfter(migration, 'email')).toEqual([...FORBIDDEN_EVENT_KEY_FRAGMENTS]);
  });

  it('keeps the two lists distinct, which is the point of having two', () => {
    /* `name` as a substring also matches `content_name` and `event_name`. If it
       ever migrates into the fragment list, every Meta standard-event parameter
       starts being refused. */
    expect(FORBIDDEN_EVENT_KEY_FRAGMENTS).not.toContain('name');
    expect(isForbiddenEventKey('content_name')).toBe(false);
    expect(isForbiddenEventKey('name')).toBe(true);
  });
});

describe.skipIf(!HAS_DATABASE)('PII guard behaviour', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await setupDatabase('piiparity');
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
  });

  it('agrees with @am/domain on every case in the corpus', async () => {
    const disagreements: string[] = [];

    for (const entry of CORPUS) {
      const inTypescript = findPiiViolations(entry.payload).length > 0;
      const { rows } = await harness.admin.query<{ violations: string[] }>(
        `select app.jsonb_pii_violations($1::jsonb) as violations`,
        [JSON.stringify(entry.payload)],
      );
      const inSql = (rows[0]?.violations ?? []).length > 0;

      if (inTypescript !== entry.pii || inSql !== entry.pii) {
        disagreements.push(
          `${entry.label}: expected ${entry.pii}, TypeScript ${inTypescript}, SQL ${inSql}`,
        );
      }
    }

    expect(disagreements).toEqual([]);
  });

  it('reports paths rather than values, in both implementations', async () => {
    const payload = { metadata: { email: 'max@example.de' } };
    const { rows } = await harness.admin.query<{ violations: string[] }>(
      `select app.jsonb_pii_violations($1::jsonb) as violations`,
      [JSON.stringify(payload)],
    );

    for (const violation of [...(rows[0]?.violations ?? []), ...findPiiViolations(payload)]) {
      expect(violation).not.toContain('max@example.de');
      expect(violation).toContain('metadata');
    }
  });
});
