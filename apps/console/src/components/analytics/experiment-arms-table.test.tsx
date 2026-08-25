import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExperimentDetail } from '@/server/analytics-port';
import { createAnalyticsFixturePort } from '@/server/analytics-fixtures';
import { ExperimentArmsTable } from './experiment-arms-table';

const NOW = '2026-08-25T09:00:00.000Z';
const port = createAnalyticsFixturePort({ now: NOW });

let winner: ExperimentDetail;
let underPowered: ExperimentDetail;

beforeAll(async () => {
  const load = async (id: string): Promise<ExperimentDetail> => {
    const detail = await port.getExperiment(id, NOW);
    if (!detail) throw new Error(`Fixture-Experiment ${id} fehlt`);
    return detail;
  };
  winner = await load('exp-formular-kurz-vs-lang');
  underPowered = await load('exp-creative-exploration-kurzumfrage');
});

function renderArms(detail: ExperimentDetail, options: { asWinner?: boolean } = {}) {
  const result = detail.evaluation.result;
  return render(
    <ExperimentArmsTable
      arms={result.arms}
      observations={detail.observations}
      thresholds={result.thresholds}
      leadingArmId={detail.evaluation.leadingArmId}
      winningArmId={options.asWinner === false ? null : result.winning_arm_id}
    />,
  );
}

function rowFor(container: HTMLElement, armKey: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-arm-key="${armKey}"]`);
  if (!row) throw new Error(`Zeile für Arm ${armKey} nicht gefunden`);
  return row;
}

describe('ExperimentArmsTable', () => {
  it('shows every conversion rate with its numerator and denominator', () => {
    const { container } = renderArms(winner);

    for (const arm of winner.evaluation.result.arms) {
      const row = rowFor(container, arm.arm_key);
      expect(row.textContent).toContain(
        `${arm.conversionRate.numerator.toLocaleString('de-DE')} / ${arm.conversionRate.denominator.toLocaleString('de-DE')}`,
      );
    }
  });

  it('renders the posterior mean, the credible interval and P(best) per arm', () => {
    const { container } = renderArms(winner);
    const leader = winner.evaluation.result.arms.find((arm) => !arm.is_control);
    const row = rowFor(container, leader?.arm_key ?? '');

    expect(row.textContent).toMatch(/\d+,\d{2} % – \d+,\d{2} %/);
    expect(within(row).getByRole('img', { name: /Glaubwürdigkeitsintervall von/ })).toBeInTheDocument();
    expect(row.textContent).toMatch(/\d+,\d %/);
  });

  it('marks the control arm and the relative lift reference', () => {
    const { container } = renderArms(winner);
    const control = winner.evaluation.result.arms.find((arm) => arm.is_control);
    const row = rowFor(container, control?.arm_key ?? '');

    expect(within(row).getByText('Kontrolle')).toBeInTheDocument();
    expect(within(row).getByText('Referenz')).toBeInTheDocument();
  });

  it('marks an arm below the minimum volume as not reached, with the exact counts', () => {
    const { container } = renderArms(underPowered);
    const thresholds = underPowered.evaluation.result.thresholds;
    const belowSessions = underPowered.evaluation.result.arms.find((arm) => !arm.meetsMinSessions);
    expect(belowSessions).toBeDefined();

    const row = rowFor(container, belowSessions?.arm_key ?? '');
    expect(within(row).getAllByText('nicht erreicht').length).toBeGreaterThan(0);
    expect(row.textContent).toContain(`/ ${thresholds.minSessionsPerArm.toLocaleString('de-DE')} Sessions`);
    expect(row.textContent).toContain(
      `/ ${thresholds.minConversionsPerArm.toLocaleString('de-DE')} Conversions`,
    );
  });

  it('labels the leading arm of an undecided test as leading, never as a winner', () => {
    const { container } = renderArms(underPowered, { asWinner: false });
    expect(within(container).queryByText('Gewinner')).toBeNull();
  });

  it('labels the winning arm of a decided test as the winner', () => {
    const { container } = renderArms(winner);
    expect(within(container).getByText('Gewinner')).toBeInTheDocument();
  });

  it('never renders a percentage without the fraction it came from', () => {
    const { container } = renderArms(winner);
    const percentages = [...container.querySelectorAll('td')].filter((cell) =>
      /%/.test(cell.textContent ?? ''),
    );
    expect(percentages.length).toBeGreaterThan(0);

    const conversionCells = [...container.querySelectorAll('[data-arm-key] td')].filter((cell) =>
      /\d\s\/\s\d/.test(cell.textContent ?? ''),
    );
    expect(conversionCells.length).toBeGreaterThanOrEqual(winner.evaluation.result.arms.length);
  });
});

describe('empty arm table', () => {
  it('renders its header even without arms rather than collapsing', () => {
    render(
      <ExperimentArmsTable
        arms={[]}
        observations={[]}
        thresholds={winner.evaluation.result.thresholds}
        leadingArmId={null}
        winningArmId={null}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Arm' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Conversion-Rate' })).toBeInTheDocument();
  });
});
