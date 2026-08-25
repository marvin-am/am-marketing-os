import { z } from 'zod';
import { healthStatusSchema } from './enums';
import { isoTimestampSchema } from './primitives';

/**
 * The launch-QA gate (spec §29).
 *
 * Two distinct blocking levels exist, and the distinction matters: a missing
 * credential must block only the *live* step, never product development or the
 * demo walkthrough. That is why `AWAITING_EXTERNAL_INPUT` is its own status and
 * why `blocksLiveOnly` is per check rather than global.
 */
export const LAUNCH_CHECK_KEYS = [
  'angle_approved',
  'offer_approved',
  'claims_approved',
  'creatives_approved',
  'creatives_distinct',
  'funnel_versions_published',
  'experiment_plan_complete',
  'primary_metric_defined',
  'min_volume_defined',
  'budget_and_limits_defined',
  'target_urls_reachable',
  'variant_assignment_working',
  'event_tracking_working',
  'pixel_capi_dedup_tested',
  'hubspot_mapping_complete',
  'hubspot_test_lead_successful',
  'contact_deal_association_verified',
  'consent_version_set',
  'meta_permissions_valid',
  'no_critical_sync_errors',
] as const;
export const launchCheckKeySchema = z.enum(LAUNCH_CHECK_KEYS);
export type LaunchCheckKey = z.infer<typeof launchCheckKeySchema>;

export const LAUNCH_CHECK_LABELS_DE: Readonly<Record<LaunchCheckKey, string>> = {
  angle_approved: 'Angle freigegeben',
  offer_approved: 'Offer freigegeben',
  claims_approved: 'Claims freigegeben',
  creatives_approved: 'Mindestens fünf Creatives freigegeben',
  creatives_distinct: 'Freigegebene Creatives sind konzeptionell unterschiedlich',
  funnel_versions_published: 'Funnel-Versionen veröffentlicht',
  experiment_plan_complete: 'Experimentplan vollständig',
  primary_metric_defined: 'Primärmetrik definiert',
  min_volume_defined: 'Mindestvolumen definiert',
  budget_and_limits_defined: 'Budget und Limits definiert',
  target_urls_reachable: 'Alle Ziel-URLs erreichbar',
  variant_assignment_working: 'Variantenzuweisung funktioniert',
  event_tracking_working: 'Event-Tracking funktioniert',
  pixel_capi_dedup_tested: 'Pixel/CAPI-Deduplizierung getestet',
  hubspot_mapping_complete: 'HubSpot-Pflichtmapping vollständig',
  hubspot_test_lead_successful: 'Erfolgreicher HubSpot-Test-Lead',
  contact_deal_association_verified: 'Contact-/Deal-Association verifiziert',
  consent_version_set: 'Consent-Version gesetzt',
  meta_permissions_valid: 'Meta-Berechtigungen gültig',
  no_critical_sync_errors: 'Keine kritischen Syncfehler',
};

/**
 * Checks that gate only the live step. While credentials and the HubSpot
 * mapping are outstanding these report AWAITING_EXTERNAL_INPUT and the rest of
 * the workflow — including the paused Meta draft against the fixture provider —
 * remains fully usable.
 */
export const LIVE_ONLY_CHECKS: readonly LaunchCheckKey[] = [
  'hubspot_mapping_complete',
  'hubspot_test_lead_successful',
  'contact_deal_association_verified',
  'meta_permissions_valid',
  'pixel_capi_dedup_tested',
];

export const launchCheckResultSchema = z.object({
  key: launchCheckKeySchema,
  labelDe: z.string(),
  status: healthStatusSchema,
  detailDe: z.string().max(1000).nullable().default(null),
  remediationDe: z.string().max(600).nullable().default(null),
  blocksLiveOnly: z.boolean(),
  /** Deep link into the console area where the operator fixes this. */
  href: z.string().max(500).nullable().default(null),
});
export type LaunchCheckResult = z.infer<typeof launchCheckResultSchema>;

export const launchQaReportSchema = z.object({
  campaign_id: z.string(),
  evaluated_at: isoTimestampSchema,
  checks: z.array(launchCheckResultSchema),
  /** True when a paused Meta draft may be created. */
  canCreateMetaDraft: z.boolean(),
  /** True when the campaign may actually go live. */
  canGoLive: z.boolean(),
  blockingDe: z.array(z.string()).default([]),
  awaitingExternalDe: z.array(z.string()).default([]),
});
export type LaunchQaReport = z.infer<typeof launchQaReportSchema>;

/**
 * Derives the two gates from a list of check results.
 *
 * `canCreateMetaDraft` ignores live-only checks that are merely waiting for
 * external input; `canGoLive` requires every check to pass.
 */
export function summarizeLaunchQa(
  campaignId: string,
  checks: readonly LaunchCheckResult[],
  evaluatedAt: string,
): LaunchQaReport {
  const blocking: string[] = [];
  const awaiting: string[] = [];

  for (const check of checks) {
    if (check.status === 'FAIL') blocking.push(check.labelDe);
    if (check.status === 'AWAITING_EXTERNAL_INPUT') awaiting.push(check.labelDe);
  }

  const draftBlockers = checks.filter(
    (c) =>
      c.status === 'FAIL' ||
      (c.status === 'AWAITING_EXTERNAL_INPUT' && !c.blocksLiveOnly),
  );

  const liveBlockers = checks.filter((c) => c.status !== 'PASS');

  return {
    campaign_id: campaignId,
    evaluated_at: evaluatedAt,
    checks: [...checks],
    canCreateMetaDraft: draftBlockers.length === 0,
    canGoLive: liveBlockers.length === 0,
    blockingDe: blocking,
    awaitingExternalDe: awaiting,
  };
}
