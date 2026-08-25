import type { MultiStepFormSpec } from '@am/funnel-schema';
import type { TrackingContext } from '@am/domain';
import type { TrackerContext } from '@am/tracking/beacon';
import { deterministicUuid } from '@am/tracking';
import { getPublishedFormSpec } from './published';
import { resolveFormTargets, type FormTargets } from './spec-targets';
import { getFunnelStore } from './store';
import { touchFor, type RuntimeContext } from './runtime-context';
import { funnelServerConfig } from './request';
import type { ArmAssignment } from './assignment';
import type { FunnelVersionRecord } from './ports';

/**
 * Everything a funnel render needs, assembled once.
 *
 * Both the live route and the preview route go through here, which is what
 * keeps them from drifting. It is also the only place in a render that writes:
 * the touch that attribution will later be frozen from, and the form instance
 * every step-level metric hangs off.
 *
 * Bot traffic writes nothing. An unfiltered funnel gets 10–30 % of its
 * "sessions" from crawlers and link previewers, none of which ever convert, and
 * a form instance per crawl is how a conversion rate quietly becomes fiction.
 */

export interface PreparedFunnel {
  version: FunnelVersionRecord;
  formSpec: MultiStepFormSpec | null;
  formTargets: FormTargets | null;
  formInstanceId: string | null;
  trackerContext: TrackerContext;
  experiment: { experimentId: string; armId: string } | null;
  redirectAllowlist: readonly string[];
}

/** Drops the null ids so a mobile event payload stays small. */
function compact(trusted: TrackingContext): Partial<TrackingContext> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(trusted)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out as Partial<TrackingContext>;
}

export async function prepareFunnel(
  version: FunnelVersionRecord,
  context: RuntimeContext,
  assignment: ArmAssignment | null,
): Promise<PreparedFunnel> {
  const config = funnelServerConfig();
  const store = getFunnelStore();
  const spec = version.spec;
  const isBot = context.trafficKind === 'BOT';

  let formSpec: MultiStepFormSpec | null = null;
  if (spec.kind === 'MULTI_STEP_FORM') {
    formSpec = spec;
  } else if (spec.kind === 'HYBRID') {
    const published = await getPublishedFormSpec(spec.form.formVersionId);
    /* A hybrid may carry an inline copy for fixtures and previews; the published
       document always wins so a live page can never serve a stale embed. */
    formSpec = published?.spec ?? spec.formSpec;
  } else {
    /* A landing page may still embed a form through an EMBEDDED_CONTACT block.
       Resolving it here is what keeps that block from rendering as a headline
       with nothing under it. */
    const embed = spec.blocks.find((block) => block.type === 'EMBEDDED_CONTACT');
    if (embed && embed.type === 'EMBEDDED_CONTACT') {
      formSpec = (await getPublishedFormSpec(embed.form.formVersionId))?.spec ?? null;
    }
  }

  if (!isBot) {
    await store.recordTouch(touchFor(context));
  }

  let formInstanceId: string | null = null;
  if (formSpec) {
    if (isBot) {
      /*
       * Crawlers and link previewers get the complete page — a blank preview in
       * a Meta share card is a real cost — but they write nothing. The id is
       * derived rather than stored, so a crawl leaves no form instance behind to
       * dilute step-level metrics.
       */
      formInstanceId = deterministicUuid(
        'bot-form-instance',
        `${context.visitorId}:${formSpec.formVersionId}`,
      );
    } else {
      const instance = await store.createFormInstance({
        visitorId: context.visitorId,
        sessionId: context.sessionId,
        funnelId: version.funnelId,
        funnelVersionId: version.funnelVersionId,
        formId: formSpec.formId,
        formVersionId: formSpec.formVersionId,
        environment: context.environment,
        trafficKind: context.trafficKind,
        experimentId: assignment?.experimentId ?? null,
        experimentArmId: assignment?.armId ?? null,
        startedAt: context.now.toISOString(),
        touch: null,
      });
      formInstanceId = instance.formInstanceId;
    }
  }

  const trackerContext: TrackerContext = {
    ...compact(context.trusted),
    visitor_id: context.visitorId,
    session_id: context.sessionId,
    funnel_id: version.funnelId,
    funnel_version_id: version.funnelVersionId,
    ...(formSpec ? { form_id: formSpec.formId, form_version_id: formSpec.formVersionId } : {}),
    ...(assignment
      ? { experiment_id: assignment.experimentId, experiment_arm_id: assignment.armId }
      : {}),
    form_instance_id: formInstanceId,
    consent_status: 'UNKNOWN',
    referrer: context.referrer,
    landing_url: context.landingUrl,
  };

  return {
    version,
    formSpec,
    formTargets: formSpec ? resolveFormTargets(formSpec, config.redirectAllowlist) : null,
    formInstanceId,
    trackerContext,
    experiment: assignment
      ? { experimentId: assignment.experimentId, armId: assignment.armId }
      : null,
    redirectAllowlist: config.redirectAllowlist,
  };
}
