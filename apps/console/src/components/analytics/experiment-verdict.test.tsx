import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { EXPERIMENT_WARNING_LABELS_DE } from '@am/experiments';
import type { ExperimentDetail } from '@/server/analytics-port';
import { createAnalyticsFixturePort } from '@/server/analytics-fixtures';
import { ExperimentVerdictPanel } from './experiment-verdict';
import { InterpretationWarnings } from './interpretation-warnings';

/**
 * The rule the experiment screens exist to enforce: no winner below the minimum
 * volume, and `PROVISIONAL` must never look like one.
 */

const NOW = '2026-08-25T09:00:00.000Z';
const port = createAnalyticsFixturePort({ now: NOW });

let winner: ExperimentDetail;
let provisional: ExperimentDetail;
let underPowered: ExperimentDetail;
let eligibilityChanging: ExperimentDetail;

beforeAll(async () => {
  const load = async (id: string): Promise<ExperimentDetail> => {
    const detail = await port.getExperiment(id, NOW);
    if (!detail) throw new Error(`Fixture-Experiment ${id} fehlt`);
    return detail;
  };
  winner = await load('exp-formular-kurz-vs-lang');
  provisional = await load('exp-bundle-angebot-hybrid');
  underPowered = await load('exp-creative-exploration-kurzumfrage');
  eligibilityChanging = await load('exp-qualifizierungs-gate');
});

function renderPanel(detail: ExperimentDetail) {
  return render(
    <ExperimentVerdictPanel
      result={detail.evaluation.result}
      observations={detail.observations}
      maturity={detail.evaluation.maturity}
      winningArmLabelDe={detail.winningArmLabelDe}
    />,
  );
}

describe('ExperimentVerdictPanel — PROVISIONAL', () => {
  it('renders the provisional verdict and says in German that it is not a winner', () => {
    expect(provisional.evaluation.result.verdict).toBe('PROVISIONAL');
    const { container } = renderPanel(provisional);

    expect(container.querySelector('[data-verdict="PROVISIONAL"]')).not.toBeNull();
    expect(screen.getAllByText('Vorläufig führend').length).toBeGreaterThan(0);
    expect(screen.getByText(/Dies ist kein Gewinner\./)).toBeInTheDocument();
    expect(
      screen.getByText(/CRM-Ergebnisse der Kohorte sind noch nicht reif/),
    ).toBeInTheDocument();
  });

  it('never renders a winner badge or a winning arm for an immature cohort', () => {
    const { container } = renderPanel(provisional);

    expect(container.querySelector('[data-verdict="WINNER"]')).toBeNull();
    expect(screen.queryByText('Gewinner', { selector: 'span' })).toBeNull();
    expect(screen.queryByText(/^Gewinnender Arm:/)).toBeNull();
  });

  it('shows the CRM maturity gate as not met, with the date it can be decided', () => {
    renderPanel(provisional);

    const row = screen.getByRole('rowheader', { name: 'CRM-Reifefenster' }).closest('tr');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Nicht erfüllt');
    expect(row?.textContent).toMatch(/Belastbar frühestens am \d{2}\.\d{2}\.\d{4}/);
  });
});

describe('ExperimentVerdictPanel — INSUFFICIENT_DATA', () => {
  it('names each missing gate and by how much it is missed', () => {
    expect(underPowered.evaluation.result.verdict).toBe('INSUFFICIENT_DATA');
    const { container } = renderPanel(underPowered);

    expect(container.querySelector('[data-verdict="INSUFFICIENT_DATA"]')).not.toBeNull();
    expect(screen.getAllByText('Datenbasis zu klein').length).toBeGreaterThan(0);
    expect(screen.getByText('Es fehlt konkret:')).toBeInTheDocument();

    const missing = screen.getByText('Es fehlt konkret:').parentElement?.textContent ?? '';
    expect(missing).toContain('Mindestlaufzeit');
    expect(missing).toContain('Conversions je Arm');
    expect(missing).toMatch(/fehlen \d/);
    expect(missing).toMatch(/gefordert .*erreicht/);
  });

  it('declares no winner at all', () => {
    const { container } = renderPanel(underPowered);
    expect(underPowered.evaluation.result.winning_arm_id).toBeNull();
    expect(container.querySelector('[data-verdict="WINNER"]')).toBeNull();
    expect(screen.queryByText(/^Gewinnender Arm:/)).toBeNull();
  });
});

describe('ExperimentVerdictPanel — WINNER', () => {
  it('names the winning arm and shows the thresholds that were met', () => {
    expect(winner.evaluation.result.verdict).toBe('WINNER');
    const { container } = renderPanel(winner);

    expect(container.querySelector('[data-verdict="WINNER"]')).not.toBeNull();
    expect(screen.getByText(/^Gewinnender Arm:/)).toBeInTheDocument();

    for (const label of [
      'Mindestlaufzeit',
      'Sessions je Arm',
      'Conversions je Arm',
      'Gewinnwahrscheinlichkeit',
      'Relevanter Uplift',
      'CRM-Reifefenster',
    ]) {
      const row = screen.getByRole('rowheader', { name: label }).closest('tr');
      expect(row?.textContent).toContain('Erfüllt');
    }
  });
});

describe('InterpretationWarnings', () => {
  it('renders the bundled-test warning prominently for a bundled experiment', () => {
    expect(provisional.evaluation.result.interpretationWarnings).toContain(
      'BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED',
    );
    const { container } = renderPanel(provisional);

    expect(
      container.querySelector('[data-warning-code="BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED"]'),
    ).not.toBeNull();
    expect(screen.getByText('Gebündelter Test — Ursache nicht zuordenbar')).toBeInTheDocument();
    expect(
      screen.getByText(EXPERIMENT_WARNING_LABELS_DE.BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED),
    ).toBeInTheDocument();
  });

  it('says a CREATIVE_EXPLORATION is not a randomised A/B test', () => {
    renderPanel(underPowered);
    expect(screen.getByText('Kein randomisierter A/B-Test')).toBeInTheDocument();
    expect(
      screen.getByText(EXPERIMENT_WARNING_LABELS_DE.META_OPTIMISED_DELIVERY_NOT_RANDOMISED),
    ).toBeInTheDocument();
  });

  it('says an eligibility-changing test is not a pure conversion test', () => {
    renderPanel(eligibilityChanging);
    expect(screen.getByText('Kein reiner Conversion-Test')).toBeInTheDocument();
    expect(
      screen.getByText(EXPERIMENT_WARNING_LABELS_DE.ELIGIBILITY_CHANGING_NOT_A_CONVERSION_TEST),
    ).toBeInTheDocument();
  });

  it('renders nothing when there is no warning to raise', () => {
    const { container } = render(<InterpretationWarnings codes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a guardrail breach with the metric it belongs to', () => {
    render(<InterpretationWarnings codes={['GUARDRAIL_BREACH:cpl']} />);
    expect(screen.getByText('Guardrail verletzt: CPL')).toBeInTheDocument();
  });
});
