import {
  CAMPAIGN_STATE_LABELS_DE,
  CAMPAIGN_STATES,
  canTransition,
  nextStates,
  type CampaignState,
} from '@am/domain';
import { CAMPAIGN_TABS, type CampaignTab } from '@/server/campaign-port';

/**
 * Which state change each tab is allowed to trigger.
 *
 * The mapping is intentionally narrow: a tab may only advance the campaign to
 * the state its own content unlocks, so nothing on the strategy tab can push a
 * campaign live. `canTransition` still has the last word.
 */
export interface AdvanceOption {
  to: CampaignState;
  /** German button label. */
  labelDe: string;
  /** True when the step reaches Meta and therefore needs `campaign.publish`. */
  publishing: boolean;
}

const CANDIDATES: Readonly<Partial<Record<CampaignTab, AdvanceOption[]>>> = {
  strategie: [
    { to: 'STRATEGY_APPROVED', labelDe: 'Strategie abschließen und Assets erzeugen', publishing: false },
    { to: 'ASSET_GENERATION', labelDe: 'Asset-Erzeugung starten', publishing: false },
  ],
  creatives: [
    { to: 'ASSET_REVIEW', labelDe: 'Assets in Prüfung geben', publishing: false },
    { to: 'TEST_PLAN_REVIEW', labelDe: 'Weiter zum Testplan', publishing: false },
  ],
  testplan: [
    { to: 'READY_FOR_LAUNCH_QA', labelDe: 'Weiter zur Launch-QA', publishing: false },
  ],
  'launch-qa': [
    { to: 'READY_FOR_META_DRAFT', labelDe: 'Für den Meta-Entwurf freigeben', publishing: false },
    { to: 'META_DRAFT_CREATED', labelDe: 'Pausierten Meta-Entwurf erstellen', publishing: true },
    { to: 'LIVE', labelDe: 'Kampagne live schalten', publishing: true },
  ],
};

function lifecycleIndex(state: CampaignState): number {
  return CAMPAIGN_STATES.indexOf(state);
}

/**
 * Whether a transition moves the campaign on rather than back.
 *
 * `CAMPAIGN_TRANSITIONS` deliberately carries back edges, so legality alone
 * says nothing about direction. `CAMPAIGN_STATES` is declared in lifecycle
 * order, which makes direction a property of the domain rather than of a list
 * maintained here: an edge added to the graph later cannot turn a rollback into
 * the campaign's next step behind the UI's back.
 */
export function isForwardTransition(from: CampaignState, to: CampaignState): boolean {
  return lifecycleIndex(to) > lifecycleIndex(from);
}

/** The first legal transition **forward** for this tab, or `null` when there is none. */
export function advanceOptionFor(tab: CampaignTab, from: CampaignState): AdvanceOption | null {
  return (
    (CANDIDATES[tab] ?? []).find(
      (option) => isForwardTransition(from, option.to) && canTransition(from, option.to),
    ) ?? null
  );
}

export interface TabAdvance {
  tab: CampaignTab;
  option: AdvanceOption;
}

/**
 * Where the campaign's forward step is actually performed.
 *
 * The button and the guidance that points at it read the same table, so they
 * cannot name different tabs — which is the only reason the guidance can claim
 * to know where the operator has to go.
 */
export function advanceTabFor(from: CampaignState): TabAdvance | null {
  for (const tab of CAMPAIGN_TABS) {
    const option = advanceOptionFor(tab, from);
    if (option !== null) return { tab, option };
  }
  return null;
}

export interface RollbackOption {
  to: CampaignState;
  /** German button label, built from the domain label of the target state. */
  labelDe: string;
  /** German sentence stating what happens, shown before anything is executed. */
  confirmDe: string;
}

/** The nearest legal state before `from`, or `null` when there is no way back. */
function previousStateOf(from: CampaignState): CampaignState | null {
  const backwards = nextStates(from).filter((to) => lifecycleIndex(to) < lifecycleIndex(from));
  if (backwards.length === 0) return null;
  return backwards.reduce((nearest, to) =>
    lifecycleIndex(to) > lifecycleIndex(nearest) ? to : nearest,
  );
}

/**
 * The undo of the step this tab performs, or `null` when it has none.
 *
 * A rollback is a legitimate operation, but it is never the campaign's next
 * step, so it is kept out of `advanceOptionFor` and offered separately. A tab
 * may only take back what it can put through — the rollback appears on the tab
 * whose own candidates lead *into* the current state — which keeps one obvious
 * place to correct a step instead of a way out of every state on every tab.
 */
export function rollbackOptionFor(tab: CampaignTab, from: CampaignState): RollbackOption | null {
  const performedHere = (CANDIDATES[tab] ?? []).some((option) => option.to === from);
  if (!performedHere) return null;

  const to = previousStateOf(from);
  if (to === null || !canTransition(from, to)) return null;

  return {
    to,
    labelDe: `Zurück auf „${CAMPAIGN_STATE_LABELS_DE[to]}"`,
    confirmDe: `Die Kampagne wird von „${CAMPAIGN_STATE_LABELS_DE[from]}" auf „${CAMPAIGN_STATE_LABELS_DE[to]}" zurückgesetzt. Das ist kein Fortschritt im Kampagnenablauf, sondern nimmt den zuletzt ausgeführten Schritt zurück.`,
  };
}
