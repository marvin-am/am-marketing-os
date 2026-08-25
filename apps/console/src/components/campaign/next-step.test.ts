import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_STATE_LABELS_DE, CAMPAIGN_STATES, type CampaignState } from '@am/domain';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort } from '@/server/campaign-fixtures';
import {
  CAMPAIGN_TAB_LABELS_DE,
  campaignTabHref,
  type CampaignTab,
  type NextRequiredAction,
} from '@/server/campaign-port';
import { presentNextStep } from './next-step';

const CAMPAIGN_ID = '11111111-2222-3333-4444-555555555555';

/**
 * The steps the campaign port computes, one per branch of its next-action
 * calculation, with the destination each one carries. Mirrored here rather than
 * imported because the port composes them from live campaign data; the sweep
 * over the fixture campaigns at the bottom fails if the port ever grows a step
 * this table does not know about.
 */
const PORT_STEPS: readonly Omit<NextRequiredAction, 'permission'>[] = [
  {
    key: 'approve_strategy',
    labelDe: 'Strategie freigeben',
    detailDe: 'Angle, Offer und Claims müssen freigegeben werden.',
    href: campaignTabHref(CAMPAIGN_ID, 'strategie'),
    blocked: false,
    blockedReasonDe: null,
  },
  {
    key: 'approve_assets',
    labelDe: 'Creatives und Funnel freigeben',
    detailDe: '3 von mindestens 5 Creatives sind freigegeben.',
    href: campaignTabHref(CAMPAIGN_ID, 'creatives'),
    blocked: true,
    blockedReasonDe: 'Es sind erst 3 von 5 erforderlichen Creatives freigegeben.',
  },
  {
    key: 'approve_test_plan',
    labelDe: 'Testplan freigeben',
    detailDe: 'Hypothese, Metriken, Mindestvolumen, Stop- und Skalierungsregeln prüfen.',
    href: campaignTabHref(CAMPAIGN_ID, 'testplan'),
    blocked: false,
    blockedReasonDe: null,
  },
  {
    key: 'run_launch_qa',
    labelDe: 'Launch-QA abschließen',
    detailDe: '0 blockierende Prüfungen, 1 wartet auf externen Input.',
    href: campaignTabHref(CAMPAIGN_ID, 'launch-qa'),
    blocked: false,
    blockedReasonDe: null,
  },
  {
    key: 'create_meta_draft',
    labelDe: 'Pausierten Meta-Entwurf erstellen',
    detailDe: 'Der Entwurf wird pausiert angelegt und schaltet nichts live.',
    href: campaignTabHref(CAMPAIGN_ID, 'launch-qa'),
    blocked: false,
    blockedReasonDe: null,
  },
  {
    key: 'approve_publish',
    labelDe: 'Veröffentlichung freigeben',
    detailDe: 'Ohne Veröffentlichungsfreigabe bleibt der Meta-Entwurf pausiert.',
    href: campaignTabHref(CAMPAIGN_ID, 'launch-qa'),
    blocked: false,
    blockedReasonDe: null,
  },
  {
    key: 'go_live',
    labelDe: 'Kampagne live schalten',
    detailDe: 'Der pausierte Entwurf wird aktiviert.',
    href: campaignTabHref(CAMPAIGN_ID, 'launch-qa'),
    blocked: false,
    blockedReasonDe: null,
  },
  {
    key: 'review_recommendations',
    labelDe: 'Offene Empfehlungen entscheiden',
    detailDe: 'Zwei Empfehlungen warten auf eine Entscheidung.',
    href: campaignTabHref(CAMPAIGN_ID, 'empfehlungen'),
    blocked: false,
    blockedReasonDe: null,
  },
  {
    key: 'resume_or_conclude',
    labelDe: 'Fortsetzen oder abschließen',
    detailDe: 'Die Kampagne ist pausiert und liefert keine Impressionen aus.',
    href: campaignTabHref(CAMPAIGN_ID, 'live-performance'),
    blocked: false,
    blockedReasonDe: null,
  },
  {
    key: 'review_learnings',
    labelDe: 'Learnings prüfen und archivieren',
    detailDe: 'Die Kampagne ist abgeschlossen; die Learnings sind erzeugt.',
    href: campaignTabHref(CAMPAIGN_ID, 'learnings'),
    blocked: false,
    blockedReasonDe: null,
  },
];

/** The port's fallback, which composes its sentence from the raw state. */
function fallbackStep(state: CampaignState): Omit<NextRequiredAction, 'permission'> {
  return {
    key: 'advance_state',
    labelDe: 'Nächsten Schritt auslösen',
    detailDe: `Aktueller Status: ${state}.`,
    href: campaignTabHref(CAMPAIGN_ID, 'strategie'),
    blocked: false,
    blockedReasonDe: null,
  };
}

function present(step: Omit<NextRequiredAction, 'permission'>, state: CampaignState) {
  return presentNextStep(
    { ...step, permission: 'campaign.edit' } as NextRequiredAction,
    state,
    CAMPAIGN_ID,
  );
}

const ROUTE_ROOT = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'app',
  '(app)',
  'kampagnen',
  '[id]',
);

/**
 * Whether the route actually mounts something that changes state.
 *
 * Read off the route tree rather than restated in the test, so the check is an
 * independent oracle: every Campaign Room mutation goes through a server action
 * in `actions.ts`, and a page that imports none of them can only be read.
 */
function routePerformsActions(tab: CampaignTab): boolean {
  const source = readFileSync(path.join(ROUTE_ROOT, tab, 'page.tsx'), 'utf8');
  return /from '\.\.\/actions'/.test(source);
}

const RAW_STATE_IN_PROSE = new RegExp(`\\b(${CAMPAIGN_STATES.join('|')})\\b`);

function everyGermanString(step: ReturnType<typeof present>): string[] {
  return [step.labelDe, step.detailDe, step.blockedReasonDe ?? '', step.noControlDe ?? ''];
}

describe('presentNextStep — destination', () => {
  /**
   * The defect this pins down: a paused campaign was told to „resume or
   * conclude" and sent to a page that renders numbers and nothing else, so the
   * single stated next step could not be taken where it pointed.
   */
  it('only says „Jetzt erledigen" where the route can carry the step out', () => {
    const broken: string[] = [];
    for (const state of CAMPAIGN_STATES) {
      for (const step of [...PORT_STEPS, fallbackStep(state)]) {
        const presented = present(step, state);
        const target = presented.target;
        if (target === null || target.kind !== 'perform') continue;
        if (!routePerformsActions(target.tab)) {
          broken.push(`${step.key} @ ${state} → /${target.tab}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('never promises an action a read-only destination cannot deliver', () => {
    for (const state of CAMPAIGN_STATES) {
      for (const step of [...PORT_STEPS, fallbackStep(state)]) {
        const target = present(step, state).target;
        if (target === null || target.kind === 'perform') continue;
        expect(target.ctaDe).not.toBe('Jetzt erledigen');
      }
    }
  });

  it('says so in German whenever the step cannot be carried out here at all', () => {
    for (const state of CAMPAIGN_STATES) {
      for (const step of [...PORT_STEPS, fallbackStep(state)]) {
        const presented = present(step, state);
        if (presented.target?.kind === 'perform' || presented.blocked) continue;
        expect(presented.noControlDe).toBeTruthy();
      }
    }
  });

  it('tells a paused campaign that resuming is not steerable here, and does not pretend otherwise', () => {
    const presented = present(
      PORT_STEPS.find((step) => step.key === 'resume_or_conclude')!,
      'PAUSED',
    );
    expect(presented.target?.kind).toBe('inspect');
    expect(presented.target?.ctaDe).toBe('„Live-Performance" ansehen');
    expect(presented.noControlDe).toContain('nicht steuerbar');
  });

  it('tells a completed campaign that archiving is not steerable here', () => {
    const presented = present(
      PORT_STEPS.find((step) => step.key === 'review_learnings')!,
      'COMPLETED',
    );
    expect(presented.target?.kind).toBe('inspect');
    expect(presented.target?.ctaDe).toBe('„Learnings" ansehen');
    expect(presented.noControlDe).toContain('Archivieren');
  });

  /**
   * The defect this pins down: with every approval granted at `ASSET_REVIEW`
   * the header pointed at the strategy tab while the only enabled advance
   * button sat on the creatives tab.
   */
  it('points at the tab that holds the advance button and names it', () => {
    const presented = present(fallbackStep('ASSET_REVIEW'), 'ASSET_REVIEW');
    expect(presented.target).toEqual({
      tab: 'creatives',
      href: campaignTabHref(CAMPAIGN_ID, 'creatives'),
      ctaDe: 'Jetzt erledigen',
      kind: 'perform',
    });
    expect(presented.labelDe).toBe('Weiter zum Testplan');
    expect(presented.detailDe).toContain(`„${CAMPAIGN_TAB_LABELS_DE.creatives}"`);
    expect(presented.detailDe).toContain('„Weiter zum Testplan"');
  });

  it('keeps a blocked step pointed at the screen that states the reason', () => {
    const blocked = PORT_STEPS.find((step) => step.key === 'approve_assets')!;
    const presented = present(blocked, 'ASSET_REVIEW');
    expect(presented.target).toEqual({
      tab: 'creatives',
      href: blocked.href,
      ctaDe: 'Blocker ansehen',
      kind: 'blocker',
    });
  });
});

describe('presentNextStep — German', () => {
  it('gives every campaign state a German label', () => {
    for (const state of CAMPAIGN_STATES) {
      const label = CAMPAIGN_STATE_LABELS_DE[state];
      expect(label).toBeTruthy();
      expect(label).not.toBe(state);
    }
  });

  /**
   * The defect this pins down: „Aktueller Status: ASSET_REVIEW." reached the
   * German header. Asserted for every state and every computed step, because a
   * raw enum in the UI is a class of bug, not one sentence.
   */
  it('never lets a raw state name reach the rendered prose', () => {
    const leaks: string[] = [];
    for (const state of CAMPAIGN_STATES) {
      for (const step of [...PORT_STEPS, fallbackStep(state)]) {
        for (const text of everyGermanString(present(step, state))) {
          if (RAW_STATE_IN_PROSE.test(text)) leaks.push(`${step.key} @ ${state}: ${text}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('replaces the raw state with its German label rather than dropping it', () => {
    for (const state of CAMPAIGN_STATES) {
      expect(present(fallbackStep(state), state).detailDe).toContain(
        CAMPAIGN_STATE_LABELS_DE[state],
      );
    }
  });
});

describe('presentNextStep — against the fixture campaigns', () => {
  it('holds for every step the port actually computes', async () => {
    const port = getCampaignPort();
    const unknownKeys: string[] = [];

    for (const id of Object.values(FIXTURE_CAMPAIGN_IDS)) {
      const header = await port.getHeader(id, false);
      if (!header) throw new Error(`Fixture campaign ${id} missing`);

      const presented = presentNextStep(header.nextAction, header.state, header.id);

      for (const text of everyGermanString(presented)) {
        expect(RAW_STATE_IN_PROSE.test(text)).toBe(false);
      }
      if (presented.target?.kind === 'perform') {
        expect(routePerformsActions(presented.target.tab)).toBe(true);
      }
      if (!PORT_STEPS.some((step) => step.key === header.nextAction.key)) {
        unknownKeys.push(header.nextAction.key);
      }
    }

    expect(unknownKeys.filter((key) => key !== 'advance_state')).toEqual([]);
  });
});
