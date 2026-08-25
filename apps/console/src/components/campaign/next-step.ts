import { CAMPAIGN_STATE_LABELS_DE, CAMPAIGN_STATES, nextStates, type CampaignState } from '@am/domain';
import {
  CAMPAIGN_TAB_LABELS_DE,
  CAMPAIGN_TABS,
  campaignTabHref,
  type CampaignTab,
  type NextRequiredAction,
} from '@/server/campaign-port';
import { advanceTabFor } from './advance';

/**
 * Turns the campaign's computed next required action into something the console
 * can honestly put on screen.
 *
 * The port decides *what* the campaign is waiting for. It does not know which
 * screen carries the control that performs it, and it composes its German
 * sentences from data that includes raw state names. Both of those become the
 * operator's problem the moment they are rendered unchanged: a call to action
 * that lands on a page with no button costs a whole walkthrough, and a raw enum
 * in German prose is not a label. This module is the single place where the
 * step, the destination and the wording are reconciled before anything renders.
 */

/**
 * The controls the Campaign Room actually mounts.
 *
 * `state-advance` is missing from the tab table on purpose: which tab carries
 * the advance depends on the state, so it is resolved through `advance.ts` —
 * the same table the button itself reads. `lifecycle` covers pausing, resuming,
 * completing and archiving, and is listed nowhere because no screen offers it.
 */
type NextStepControl =
  | 'approval:STRATEGY'
  | 'approval:ASSETS'
  | 'approval:TEST_PLAN'
  | 'approval:PUBLISH'
  | 'state-advance'
  | 'recommendation-execution'
  | 'lead-sync'
  | 'lifecycle';

const TAB_CONTROLS: Readonly<Record<CampaignTab, readonly NextStepControl[]>> = {
  strategie: ['approval:STRATEGY'],
  creatives: ['approval:ASSETS'],
  funnel: [],
  testplan: ['approval:TEST_PLAN'],
  'launch-qa': ['approval:PUBLISH'],
  'live-performance': [],
  'leads-sales': ['lead-sync'],
  empfehlungen: ['recommendation-execution'],
  learnings: [],
  versionen: [],
};

/** The control each computed action needs. Unknown keys resolve to `null`. */
const CONTROL_FOR_ACTION: Readonly<Record<string, NextStepControl>> = {
  approve_strategy: 'approval:STRATEGY',
  approve_assets: 'approval:ASSETS',
  approve_test_plan: 'approval:TEST_PLAN',
  approve_publish: 'approval:PUBLISH',
  run_launch_qa: 'state-advance',
  create_meta_draft: 'state-advance',
  go_live: 'state-advance',
  advance_state: 'state-advance',
  review_recommendations: 'recommendation-execution',
  resume_or_conclude: 'lifecycle',
  review_learnings: 'lifecycle',
};

/** The action the port falls back to when no specific step applies. */
const GENERIC_ADVANCE_KEY = 'advance_state';

/**
 * What a destination link promises.
 *
 * `perform` is the only kind that may say „Jetzt erledigen": it is reserved for
 * a route that renders the control the step needs. `blocker` shows the reason
 * the step cannot be taken, `inspect` only shows the state.
 */
export type NextStepTargetKind = 'perform' | 'blocker' | 'inspect';

export interface NextStepTarget {
  tab: CampaignTab;
  href: string;
  /** German call to action. It promises exactly what the destination delivers. */
  ctaDe: string;
  kind: NextStepTargetKind;
}

export interface PresentedNextStep {
  key: string;
  /** German name of the step. Never a raw enum. */
  labelDe: string;
  /** German detail, extended with where the step is performed when that is known. */
  detailDe: string;
  blocked: boolean;
  blockedReasonDe: string | null;
  /** `null` when there is nowhere useful to send the operator at all. */
  target: NextStepTarget | null;
  /** German sentence stating that the step itself cannot be carried out here. */
  noControlDe: string | null;
}

/**
 * Longest first, so `READY_FOR_META_DRAFT` is replaced before any shorter name
 * that could match inside it.
 */
const RAW_STATE_PATTERN = new RegExp(
  `\\b(${[...CAMPAIGN_STATES].sort((a, b) => b.length - a.length).join('|')})\\b`,
  'g',
);

/**
 * German prose must never carry a raw state name. The sentence is composed
 * where the data lives, so the UI is the last point at which a leaked enum can
 * still be caught — and it is caught for every state rather than for the one
 * that happened to be noticed.
 */
function withGermanStateLabels(text: string): string {
  return text.replace(
    RAW_STATE_PATTERN,
    (state) => CAMPAIGN_STATE_LABELS_DE[state as CampaignState],
  );
}

function tabOfHref(campaignId: string, href: string): CampaignTab | null {
  return CAMPAIGN_TABS.find((tab) => campaignTabHref(campaignId, tab) === href) ?? null;
}

function tabRendering(control: NextStepControl): CampaignTab | null {
  return CAMPAIGN_TABS.find((tab) => TAB_CONTROLS[tab].includes(control)) ?? null;
}

export function presentNextStep(
  action: NextRequiredAction,
  state: CampaignState,
  campaignId: string,
): PresentedNextStep {
  const control = CONTROL_FOR_ACTION[action.key] ?? null;
  const advance = control === 'state-advance' ? advanceTabFor(state) : null;

  // The fallback action has no name of its own — the button that performs it
  // does, and naming it is the difference between guidance and a riddle.
  const labelDe =
    action.key === GENERIC_ADVANCE_KEY && advance !== null
      ? advance.option.labelDe
      : action.labelDe;

  const detailDe =
    advance === null
      ? action.detailDe
      : `${action.detailDe} Ausführen auf dem Tab „${CAMPAIGN_TAB_LABELS_DE[advance.tab]}" über „${advance.option.labelDe}".`;

  const performTab =
    control === 'state-advance' ? (advance?.tab ?? null) : control === null ? null : tabRendering(control);

  const inspectTab = tabOfHref(campaignId, action.href);

  let target: NextStepTarget | null;
  let noControlDe: string | null = null;

  if (action.blocked) {
    // A blocked step is not performed, it is understood: the port points at the
    // screen that states the reason, and the call to action says only that.
    target =
      inspectTab === null
        ? null
        : { tab: inspectTab, href: action.href, ctaDe: 'Blocker ansehen', kind: 'blocker' };
  } else if (performTab !== null) {
    target = {
      tab: performTab,
      href: campaignTabHref(campaignId, performTab),
      ctaDe: 'Jetzt erledigen',
      kind: 'perform',
    };
  } else {
    target =
      inspectTab === null
        ? null
        : {
            tab: inspectTab,
            href: action.href,
            ctaDe: `„${CAMPAIGN_TAB_LABELS_DE[inspectTab]}" ansehen`,
            kind: 'inspect',
          };
    noControlDe = missingControlDe(control, state, inspectTab);
  }

  return {
    key: action.key,
    labelDe: withGermanStateLabels(labelDe),
    detailDe: withGermanStateLabels(detailDe),
    blocked: action.blocked,
    blockedReasonDe:
      action.blockedReasonDe === null ? null : withGermanStateLabels(action.blockedReasonDe),
    target,
    noControlDe,
  };
}

function missingControlDe(
  control: NextStepControl | null,
  state: CampaignState,
  inspectTab: CampaignTab | null,
): string {
  const tabClause =
    inspectTab === null
      ? ''
      : ` Der Tab „${CAMPAIGN_TAB_LABELS_DE[inspectTab]}" zeigt den Stand, ändert ihn aber nicht.`;

  if (control === 'lifecycle') {
    return `Fortsetzen, Abschließen und Archivieren sind im Kampagnenraum derzeit nicht steuerbar.${tabClause}`;
  }
  if (nextStates(state).length === 0) {
    return `Im Kampagnenablauf folgt auf „${CAMPAIGN_STATE_LABELS_DE[state]}" kein weiterer Schritt.`;
  }
  return `Für diesen Schritt gibt es im Kampagnenraum derzeit keine Steuerung.${tabClause}`;
}
