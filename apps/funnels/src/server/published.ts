import { getFunnelStore } from './store';
import { assignFunnelArm, type ArmAssignment } from './assignment';
import type { FunnelVersionRecord, PublishedFormRecord } from './ports';

/**
 * Published-spec caching.
 *
 * A published version is immutable (AGENTS.md rule 6), which is what makes an
 * unbounded cache correct rather than merely convenient: the document behind a
 * `funnel_version_id` can never change, so it is read once per process and then
 * served from memory. The only thing that *does* move is which version a slug
 * points at, so that mapping gets a short TTL instead.
 *
 * This matters on the critical path: an ad click has to paint before the
 * visitor's thumb leaves the screen, and re-reading a 60 kB spec document per
 * request is a measurable share of TTFB.
 *
 * Drafts are deliberately not cached. A preview must show the current draft,
 * and a cached draft is a preview that lies.
 */

/** How long a slug → version mapping is trusted. Publishing is rare. */
export const SLUG_CACHE_TTL_MS = 60_000;

const versionCache = new Map<string, FunnelVersionRecord>();
const formCache = new Map<string, PublishedFormRecord>();
const slugCache = new Map<string, { funnelVersionId: string; expiresAt: number }>();

export function resetPublishedCache(): void {
  versionCache.clear();
  formCache.clear();
  slugCache.clear();
}

function remember(record: FunnelVersionRecord): FunnelVersionRecord {
  if (record.state === 'PUBLISHED') versionCache.set(record.funnelVersionId, record);
  return record;
}

/** The live version behind a public slug, or `null`. Never a draft. */
export async function getPublishedFunnelBySlug(
  slug: string,
  now: number = Date.now(),
): Promise<FunnelVersionRecord | null> {
  const cached = slugCache.get(slug);
  if (cached && cached.expiresAt > now) {
    const version = versionCache.get(cached.funnelVersionId);
    if (version) return version;
  }

  const record = await getFunnelStore().loadPublishedFunnelBySlug(slug);
  if (!record || record.state !== 'PUBLISHED') return null;

  slugCache.set(slug, { funnelVersionId: record.funnelVersionId, expiresAt: now + SLUG_CACHE_TTL_MS });
  return remember(record);
}

/**
 * Any version by id. Published versions come from the cache; anything else is
 * read through every time, because only a published version is frozen.
 */
export async function getFunnelVersion(
  funnelVersionId: string,
): Promise<FunnelVersionRecord | null> {
  const cached = versionCache.get(funnelVersionId);
  if (cached) return cached;
  const record = await getFunnelStore().loadFunnelVersion(funnelVersionId);
  return record ? remember(record) : null;
}

export async function getPublishedFormSpec(
  formVersionId: string,
): Promise<PublishedFormRecord | null> {
  const cached = formCache.get(formVersionId);
  if (cached) return cached;
  const record = await getFunnelStore().loadPublishedFormSpec(formVersionId);
  if (!record || record.state !== 'PUBLISHED') return null;
  formCache.set(formVersionId, record);
  return record;
}

export interface ServedFunnel {
  /** The version actually rendered — the assigned arm's, when one applies. */
  version: FunnelVersionRecord;
  /** The version the slug points at, before the experiment was applied. */
  baseVersion: FunnelVersionRecord;
  assignment: ArmAssignment | null;
}

/**
 * Resolves a slug into the exact version this visitor gets.
 *
 * Assignment happens *before* the spec is chosen, on the server, so the visitor
 * never sees the control paint and then swap to the variant.
 */
export async function resolveServedFunnel(
  slug: string,
  visitorId: string,
): Promise<ServedFunnel | null> {
  const base = await getPublishedFunnelBySlug(slug);
  if (!base) return null;

  const assignment = assignFunnelArm(base.experiment, visitorId);
  if (!assignment || assignment.funnelVersionId === base.funnelVersionId) {
    return { version: base, baseVersion: base, assignment };
  }

  const armVersion = await getFunnelVersion(assignment.funnelVersionId);
  /* An arm pointing at a version that is missing or unpublished must not take
     the visitor down with it — the control is served and the arm is simply not
     applied, which is visible in the exposure counts rather than as an error. */
  if (!armVersion || armVersion.state !== 'PUBLISHED') {
    return { version: base, baseVersion: base, assignment: null };
  }

  return { version: armVersion, baseVersion: base, assignment };
}
