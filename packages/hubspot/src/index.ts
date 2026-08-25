/**
 * `@am/hubspot` — the CRM adapter.
 *
 * The customer's HubSpot property names, VQ definition, pipeline and deal stages
 * are supplied later through the versioned mapping wizard. Nothing in this
 * package is customer specific: the mapping document is the only place where a
 * portal's vocabulary is described, and a fixture mapping stands in until the
 * real one arrives.
 *
 * Writes are off by default (`EXTERNAL_WRITES_ENABLED` / `HUBSPOT_WRITES_ENABLED`)
 * and every write then returns a `DryRunResult` describing exactly what it would
 * have sent.
 */

export * from './types';
export * from './mapping/schema';
export * from './mapping/translate';
export * from './provider';
export * from './factory';
export * from './sync';
export * from './webhooks';
export * from './reconcile';
export * from './test-lead';
export * from './health';
export * from './fixtures';
