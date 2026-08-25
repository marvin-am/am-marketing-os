import { canTransition, type CampaignState } from '@am/domain';
import type { CampaignTab } from '@/server/campaign-port';

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

/** The first legal advance for this tab, or `null` when there is none. */
export function advanceOptionFor(tab: CampaignTab, from: CampaignState): AdvanceOption | null {
  return (CANDIDATES[tab] ?? []).find((option) => canTransition(from, option.to)) ?? null;
}
