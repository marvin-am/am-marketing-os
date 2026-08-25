/**
 * `@am/meta` — the Meta Marketing API adapter.
 *
 * Public surface, grouped by concern:
 *
 * - `types`      — Graph API / Conversions API wire schemas and the mapping
 *                  onto our domain records.
 * - `provider`   — the `MetaProvider` interface plus its two implementations.
 * - `factory`    — the one place fixture vs. live is decided.
 * - `import`     — resumable, idempotent historical import.
 * - `draft`      — reviewable plans and paused draft creation.
 * - `commands`   — the external command lifecycle and budget guards.
 * - `capi`       — pixel + Conversions API, one source of truth per event.
 * - `health`     — the setup-wizard probes.
 *
 * Two invariants hold across all of it: no mutation happens without
 * `canWriteMeta(flags)` / `canDispatchCapi(flags)`, and every newly created
 * Meta object is `PAUSED`.
 */

export * from './types';
export * from './errors';
export * from './retry';
export * from './provider';
export * from './factory';
export * from './import-mode';
export * from './import';
export * from './draft';
export * from './commands';
export * from './capi';
export * from './health';

/**
 * Fixture identifiers, exported so the console's demo mode and the contract
 * tests can address the deterministic dataset without importing the
 * implementation module directly.
 */
export {
  FIXTURE_AD_ACCOUNT_ID,
  FIXTURE_ANCHOR,
  FIXTURE_BUSINESS_ID,
  FIXTURE_CAMPAIGN_COUNT,
  FIXTURE_CURRENCY,
  FIXTURE_DATASET_ID,
  FIXTURE_INSTAGRAM_ACTOR_ID,
  FIXTURE_PAGE_ID,
  FIXTURE_PIXEL_ID,
  FIXTURE_SEED,
} from './fixture-provider';
