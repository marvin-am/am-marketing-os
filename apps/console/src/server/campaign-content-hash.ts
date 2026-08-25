import { canonicalize, fnv1a32, type ApprovalKind } from '@am/domain';

/**
 * The content an approval covers, and the hash over it.
 *
 * An approval is granted against a *content hash* rather than an object id, so
 * both `CampaignPort` implementations have to agree on two things: which fields
 * a given `ApprovalKind` covers, and how those fields become 64 hex characters.
 * If either drifts, the same campaign is approved in one store and stale in the
 * other — and the invalidation rule the UI states as a fact becomes a property
 * of which store happens to be wired up.
 *
 * Hence one definition here, used by the fixture and by the repository-backed
 * port alike.
 */

/**
 * 64-hex content hash. Pure and synchronous on purpose: the same function has
 * to run in a server component and in a jsdom test, so `node:crypto` and
 * `crypto.subtle` are both out.
 */
export function campaignContentHash(value: unknown): string {
  const canonical = canonicalize(value);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += (fnv1a32(`${i}:${canonical}`) >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

/** Angle, offer, claims and core message — what a STRATEGY approval covers. */
export interface StrategyContent {
  angle: string;
  offer: string;
  claims: string[];
  coreMessage: string;
  /**
   * Content hash of the campaign version the strategy was read from.
   *
   * The fixture holds no version rows and passes `null`. The repository-backed
   * port passes `campaign_versions.content_hash`, which is how a change that
   * produces a new version — a reworded claim, for instance — still reaches this
   * hash even though the `claims` table has no repository to read it from.
   */
  versionHash: string | null;
}

/** Approved creative keys and the funnel mix — what an ASSETS approval covers. */
export interface AssetsContent {
  creatives: string[];
  funnels: string[];
}

/** Plan identity and the budget it was sized for — a TEST_PLAN approval. */
export interface TestPlanContent {
  plan: string;
  dailyBudgetMinor: number;
}

/**
 * Publication identity.
 *
 * Deliberately narrow: a PUBLISH approval covers the decision to publish *this*
 * campaign, and the upstream areas already carry their own approvals. Folding
 * them in here would invalidate the publication approval twice for one change.
 */
export interface PublishContent {
  publish: string;
}

export function strategyContentHash(content: StrategyContent): string {
  return campaignContentHash(content);
}

export function assetsContentHash(content: AssetsContent): string {
  // Sorted so that re-ordering a review queue is not a content change.
  return campaignContentHash({
    creatives: [...content.creatives].sort(),
    funnels: [...content.funnels].sort(),
  });
}

export function testPlanContentHash(content: TestPlanContent): string {
  return campaignContentHash(content);
}

export function publishContentHash(content: PublishContent): string {
  return campaignContentHash(content);
}

/** The four approval kinds the Campaign Room shows, in the order it shows them. */
export const CAMPAIGN_APPROVAL_KINDS: readonly ApprovalKind[] = [
  'STRATEGY',
  'ASSETS',
  'TEST_PLAN',
  'PUBLISH',
];
