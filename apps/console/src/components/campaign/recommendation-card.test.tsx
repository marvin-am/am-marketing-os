import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { dryRun, type ExternalCommand, type Recommendation } from '@am/domain';
import { actionOk, type ActionResult } from '@/lib/action-result';
import type { CommandOutcome, RecommendationView } from '@/server/campaign-port';
import { RecommendationCard } from './recommendation-card';

const CAMPAIGN_ID = '9f3c1a20-1b44-4d2e-9c77-0e5a4b6d8f21';
const RECOMMENDATION_ID = '5c7e2b41-3a09-4f6b-8d12-7e4a9c0b5d33';

const RECOMMENDATION: Recommendation = {
  id: RECOMMENDATION_ID,
  campaign_id: CAMPAIGN_ID,
  experiment_id: null,
  created_at: '2026-08-24T09:00:00.000Z',
  action: 'PAUSE_CREATIVE',
  state: 'OPEN',
  ruleId: 'PAUSE_CREATIVE_UNDERPERFORMING',
  titleDe: 'Creative „Der Monat ohne Anfragen" pausieren',
  summaryDe: 'Das Creative liegt beim CPL deutlich über dem Kampagnendurchschnitt.',
  explanationDe: null,
  nextHypothesisDe: null,
  facts: [
    {
      metric: 'submission_rate',
      label: 'Submission-Rate',
      numerator: 12,
      denominator: 340,
      value: 12 / 340,
      currency: null,
      comparisonLabel: 'Kampagnendurchschnitt',
      comparisonValue: 0.061,
    },
  ],
  comparisonBasisDe:
    'Verglichen mit dem gewichteten Kampagnendurchschnitt der letzten 14 Tage, gleiche Laufzeit.',
  maturity: 'PARTIAL',
  attributionCoverage: 0.83,
  uncertaintyDe: '95-%-Intervall der Submission-Rate: 2,1 % bis 4,4 %.',
  risk: 'LOW',
  riskNoteDe: 'Pausieren ist reversibel.',
  affectedMetaObjects: [
    {
      level: 'AD',
      external_id: '120214880031240521',
      name: 'AM | Potenzialanalyse | Der Monat ohne Anfragen',
      currentStatus: 'ACTIVE',
      currentDailyBudgetMinor: null,
      proposedDailyBudgetMinor: null,
    },
  ],
  proposedBudgetChangePct: null,
  execution: null,
};

const VIEW: RecommendationView = {
  recommendation: RECOMMENDATION,
  command: null,
  lastDryRun: null,
  requestPreview: { ad_id: '120214880031240521', status: 'PAUSED' },
  actionSummaryDe: 'Setzt die Anzeige „AM | Potenzialanalyse" bei Meta auf PAUSED.',
};

/** A recommendation the rules emit that asks for nothing to be sent anywhere. */
const NO_ACTION_VIEW: RecommendationView = {
  recommendation: {
    ...RECOMMENDATION,
    id: '8a1f6d92-4b30-4c8e-9a51-2f7c3e5d0a14',
    action: 'COLLECT_MORE_DATA',
    ruleId: 'COLLECT_MORE_DATA',
    titleDe: 'Funnelarm „Landingpage mit Direktkontakt" weiterlaufen lassen',
    summaryDe: 'Der Arm hat das Mindestvolumen je Arm noch nicht erreicht.',
    affectedMetaObjects: [],
  },
  command: null,
  lastDryRun: null,
  requestPreview: {},
  actionSummaryDe: 'Keine externe Aktion — der Arm läuft unverändert weiter.',
};

const noopDecide = async (): Promise<ActionResult<RecommendationView>> => ({
  status: 'error',
  code: 'NOT_CALLED',
  messageDe: 'In diesem Test wird keine Entscheidung erwartet.',
  retryable: false,
});

function confirmedCommand(state: ExternalCommand['state']): ExternalCommand {
  return {
    id: '3b8d1f60-2c55-4e17-9a83-6d1c4f0e7b92',
    provider: 'META',
    kind: 'PAUSE_CREATIVE',
    idempotencyKey: 'fixture-pause-creative',
    state,
    requestedBy: '11111111-1111-4111-8111-111111111111',
    requestedAt: '2026-08-24T10:00:00.000Z',
    confirmedAt: state === 'PROVIDER_CONFIRMED' ? '2026-08-24T10:00:05.000Z' : null,
    reconciledAt: null,
    requestPreview: { ad_id: '120214880031240521', status: 'PAUSED' },
    providerResponseRedacted: { success: true },
    error: null,
    attemptCount: 1,
    campaign_id: CAMPAIGN_ID,
  };
}

describe('RecommendationCard', () => {
  it('renders each fact with its numerator, denominator and comparison basis', () => {
    render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={VIEW}
        canExecute
        execute={vi.fn()}
        decide={noopDecide}
      />,
    );

    const fact = document.querySelector('[data-fact-metric="submission_rate"]');
    expect(fact).not.toBeNull();
    expect(fact).toHaveTextContent('3,5 %');
    expect(fact).toHaveTextContent('12 / 340');
    expect(fact).toHaveTextContent('Kampagnendurchschnitt: 6,1 %');

    expect(document.querySelector('[data-comparison-basis]')).toHaveTextContent(
      'Verglichen mit dem gewichteten Kampagnendurchschnitt der letzten 14 Tage, gleiche Laufzeit.',
    );
    expect(screen.getByText(VIEW.recommendation.uncertaintyDe)).toBeInTheDocument();
    expect(screen.getByText('Risiko: niedrig')).toBeInTheDocument();
    expect(screen.getByText('120214880031240521')).toBeInTheDocument();
    expect(screen.getByText(VIEW.actionSummaryDe)).toBeInTheDocument();
  });

  it('opens a confirmation dialog and executes nothing until it is confirmed', async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () =>
      actionOk<CommandOutcome>({
        command: confirmedCommand('PROVIDER_CONFIRMED'),
        state: 'PROVIDER_CONFIRMED',
      }),
    );

    render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={VIEW}
        canExecute
        execute={execute}
        decide={noopDecide}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Annehmen und ausführen' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Creative pausieren ausführen');
    expect(dialog).toHaveTextContent('"ad_id": "120214880031240521"');
    expect(execute).not.toHaveBeenCalled();

    // The confirm button stays inert until the phrase is typed exactly.
    const confirm = screen.getByRole('button', { name: 'An Meta senden' });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(execute).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox'), 'AUSFÜHREN');
    await user.click(screen.getByRole('button', { name: 'An Meta senden' }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({
        campaignId: CAMPAIGN_ID,
        recommendationId: RECOMMENDATION_ID,
      }),
    );
  });

  it('cancelling the dialog executes nothing', async () => {
    const user = userEvent.setup();
    const execute = vi.fn();

    render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={VIEW}
        canExecute
        execute={execute}
        decide={noopDecide}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Annehmen und ausführen' }));
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));

    expect(execute).not.toHaveBeenCalled();
  });

  /** A dry run is not a success and must never be rendered as one. */
  it('renders a dry-run result as a dry-run notice and never as success', async () => {
    const user = userEvent.setup();
    const execute = vi.fn(
      async (): Promise<ActionResult<CommandOutcome>> => ({
        status: 'dry_run',
        dryRun: dryRun('META', 'ad.update.status', {
          ad_id: '120214880031240521',
          status: 'PAUSED',
        }),
      }),
    );

    render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={VIEW}
        canExecute
        execute={execute}
        decide={noopDecide}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Annehmen und ausführen' }));
    await screen.findByRole('alertdialog');
    await user.type(screen.getByRole('textbox'), 'AUSFÜHREN');
    await user.click(screen.getByRole('button', { name: 'An Meta senden' }));

    await waitFor(() => expect(document.querySelector('[data-dry-run="true"]')).not.toBeNull());

    expect(screen.getByText('Dry-Run – nicht ausgeführt')).toBeInTheDocument();
    expect(
      screen.getByText(/Externe Schreibzugriffe sind deaktiviert/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Empfehlung ausgeführt und vom Provider bestätigt.'),
    ).not.toBeInTheDocument();
    expect(document.querySelector('[data-execution-confirmed]')).toBeNull();
  });

  it('shows a completed external action only once the provider confirmed it', () => {
    render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={{
          ...VIEW,
          recommendation: { ...RECOMMENDATION, state: 'EXECUTED' },
          command: confirmedCommand('PROVIDER_CONFIRMED'),
        }}
        canExecute
        execute={vi.fn()}
        decide={noopDecide}
      />,
    );

    expect(document.querySelector('[data-execution-confirmed]')).not.toBeNull();
    expect(screen.getByText('Von Meta bestätigt')).toBeInTheDocument();
  });

  it('does not present an unconfirmed command as done', () => {
    render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={{
          ...VIEW,
          recommendation: { ...RECOMMENDATION, state: 'EXECUTING' },
          command: confirmedCommand('IN_FLIGHT'),
        }}
        canExecute
        execute={vi.fn()}
        decide={noopDecide}
      />,
    );

    expect(document.querySelector('[data-execution-confirmed]')).toBeNull();
    expect(screen.getByText('Noch nicht vom Provider bestätigt')).toBeInTheDocument();
    expect(
      screen.getByText(/gilt die Änderung als nicht ausgeführt/),
    ).toBeInTheDocument();
  });

  it('offers no execute button to a role that may not execute', () => {
    render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={VIEW}
        canExecute={false}
        execute={vi.fn()}
        decide={noopDecide}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Annehmen und ausführen' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Ihre Rolle darf Empfehlungen nicht ausführen/)).toBeInTheDocument();
  });
});

describe('a recommendation that changes nothing at Meta', () => {
  /**
   * Its payload is empty and the server refuses to execute it, so a dialog
   * promising to send it to Meta offers a button that can never succeed.
   */
  it('is never offered a send-to-Meta dialog', async () => {
    const user = userEvent.setup();
    const execute = vi.fn();

    render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={NO_ACTION_VIEW}
        canExecute
        execute={execute}
        decide={noopDecide}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Annehmen und ausführen' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Keine — diese Empfehlung verändert nichts bei Meta.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Annehmen' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'An Meta senden' })).not.toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
  });

  /** Without these two controls the item stays OPEN forever. */
  it('can be accepted and can be dismissed, and says nothing was sent', async () => {
    const user = userEvent.setup();
    const decide = vi.fn(
      async (input: {
        campaignId: string;
        recommendationId: string;
        decision: 'ACCEPT' | 'DISMISS';
      }): Promise<ActionResult<RecommendationView>> =>
        actionOk<RecommendationView>({
          ...NO_ACTION_VIEW,
          recommendation: {
            ...NO_ACTION_VIEW.recommendation,
            state: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DISMISSED',
          },
        }),
    );

    const { unmount } = render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={NO_ACTION_VIEW}
        canExecute
        execute={vi.fn()}
        decide={decide}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Annehmen' }));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith({
        campaignId: CAMPAIGN_ID,
        recommendationId: NO_ACTION_VIEW.recommendation.id,
        decision: 'ACCEPT',
      }),
    );
    expect(
      await screen.findByText('Empfehlung entschieden. Es wurde nichts an Meta gesendet.'),
    ).toBeInTheDocument();
    // The decided card stops offering controls it no longer has.
    expect(screen.queryByRole('button', { name: 'Annehmen' })).not.toBeInTheDocument();
    unmount();

    decide.mockClear();
    render(
      <RecommendationCard
        campaignId={CAMPAIGN_ID}
        view={NO_ACTION_VIEW}
        canExecute
        execute={vi.fn()}
        decide={decide}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Verwerfen' }));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith({
        campaignId: CAMPAIGN_ID,
        recommendationId: NO_ACTION_VIEW.recommendation.id,
        decision: 'DISMISS',
      }),
    );
    expect(screen.queryByRole('button', { name: 'Verwerfen' })).not.toBeInTheDocument();
  });
});
