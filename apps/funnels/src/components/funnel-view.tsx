import type { MultiStepFormSpec } from '@am/funnel-schema';
import type { TrackerContext } from '@am/tracking/beacon';
import type { FunnelVersionRecord } from '@/server/ports';
import type { FormTargets } from '@/server/spec-targets';
import { COLLECT_ENDPOINT, FORM_ANCHOR, SUBMIT_ENDPOINT } from '@/lib/endpoints';
import { FunnelBeacon } from './funnel-beacon';
import { FunnelForm } from './funnel-form';
import { PageBlocks } from './page-blocks';
import { ThemeScope } from './theme-scope';

/**
 * One renderer for all three funnel kinds, shared by the live route and the
 * preview route.
 *
 * Sharing it is the point: a preview that renders through a different code path
 * is a preview that can disagree with production, and "it looked right in
 * preview" is how an unreviewed page reaches an ad account. The only difference
 * between the two callers is the banner above this component and the cookie
 * that classifies the traffic.
 */

export interface FunnelViewProps {
  version: FunnelVersionRecord;
  /** The published form document, when this funnel serves one. */
  formSpec: MultiStepFormSpec | null;
  formTargets: FormTargets | null;
  formInstanceId: string | null;
  trackerContext: TrackerContext;
  experiment: { experimentId: string; armId: string } | null;
  redirectAllowlist: readonly string[];
}

function emptyTargets(): FormTargets {
  return {
    privacy: null,
    variants: {},
    success: { primary: null, secondary: null, booking: null },
  };
}

export function FunnelView({
  version,
  formSpec,
  formTargets,
  formInstanceId,
  trackerContext,
  experiment,
  redirectAllowlist,
}: FunnelViewProps) {
  const spec = version.spec;
  const hasForm = formSpec !== null && formInstanceId !== null;

  /* Built once and placed by kind. The entry events (`funnel_viewed`, and the
     single `experiment_exposed`) ride on whichever client component the page
     actually ships, so exactly one of them emits them. */
  const form = hasForm ? (
    <FunnelForm
      spec={formSpec}
      funnelVersionId={version.funnelVersionId}
      formInstanceId={formInstanceId}
      targets={formTargets ?? emptyTargets()}
      trackerContext={trackerContext}
      experiment={experiment}
      submitEndpoint={SUBMIT_ENDPOINT}
      collectEndpoint={COLLECT_ENDPOINT}
      skipIntro={spec.kind !== 'MULTI_STEP_FORM'}
    />
  ) : null;

  const beacon = (
    <FunnelBeacon
      collectEndpoint={COLLECT_ENDPOINT}
      trackerContext={trackerContext}
      experiment={experiment}
    />
  );

  if (spec.kind === 'MULTI_STEP_FORM') {
    /* The funnel document *is* the form document. Rendering the version's own
       spec rather than a separately loaded one keeps the arm the visitor was
       assigned and the form they fill in from ever drifting apart. */
    return <ThemeScope theme={spec.theme}>{form ?? beacon}</ThemeScope>;
  }

  const embedsFormInBlock = spec.blocks.some((block) => block.type === 'EMBEDDED_CONTACT');

  return (
    <ThemeScope theme={spec.theme}>
      <PageBlocks
        blocks={spec.blocks}
        formAnchor={hasForm ? FORM_ANCHOR : null}
        redirectAllowlist={redirectAllowlist}
        embeddedForm={embedsFormInBlock ? form : null}
      />
      {/*
       * A hybrid whose blocks carry no EMBEDDED_CONTACT still needs its form on
       * the page. It is rendered inline even when the spec asks for a modal: a
       * modal puts an extra tap between the ad click and the first question, and
       * a hybrid page is short by design.
       */}
      {hasForm && !embedsFormInBlock ? (
        <section id={FORM_ANCHOR} className="border-t border-border bg-surface-sunken">
          {form}
        </section>
      ) : null}
      {hasForm ? null : beacon}
    </ThemeScope>
  );
}
