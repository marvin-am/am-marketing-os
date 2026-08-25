/**
 * `@am/tracking` — the first-party event contract.
 *
 * Four things live here, and they only work as a set:
 *
 * - **Signed launch tokens** (`tokens.ts`) draw the line between *trusted*
 *   internal ids, which can only come out of a server-signed token, and
 *   *untrusted* query parameters, which are reporting data and may never
 *   overwrite an id.
 * - **Identity** (`identity.ts`) issues first-party visitor and session cookies
 *   and classifies traffic, which is what keeps preview, bot and test traffic
 *   out of production metrics.
 * - **Assignment** (`assignment.ts`) buckets a visitor into an experiment arm
 *   deterministically, so the same person sees the same variant forever.
 * - **Collection and attribution** (`collector.ts`, `attribution.ts`) validate
 *   events against the domain schema, reject anything carrying personal data,
 *   and freeze attribution into an immutable snapshot at submit.
 *
 * There is no React and no database access in this package.
 *
 * **Browser code must import `@am/tracking/beacon` directly.** This barrel pulls
 * in `node:crypto` through the token and assignment modules — signing secrets
 * and bucket hashing are server concerns and must never reach a client bundle.
 */

export * from './tokens';
export * from './identity';
export * from './assignment';
export * from './collector';
export * from './attribution';
export type {
  BeaconTransport,
  QueuedEvent,
  Tracker,
  TrackerContext,
  TrackerOptions,
  TrackProps,
} from './beacon';
