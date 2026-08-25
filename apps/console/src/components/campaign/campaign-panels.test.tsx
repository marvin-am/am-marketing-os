import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GENERATION_DEFAULTS } from '@am/domain';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort } from '@/server/campaign-fixtures';
import { CrmPanel } from './crm-panel';
import { FunnelList } from './funnel-list';
import { LearningList } from './learning-list';
import { PerformancePanel } from './performance-panel';
import { StrategyPanel } from './strategy-panel';
import { TestPlanPanel } from './test-plan-panel';
import { VersionHistory } from './version-history';

const port = getCampaignPort();

async function required<T>(value: Promise<T | null>): Promise<T> {
  const resolved = await value;
  if (!resolved) throw new Error('Fixture view missing');
  return resolved;
}

describe('Strategie tab', () => {
  it('shows every claim with an evidence reference or an explicit hypothesis label', async () => {
    const view = await required(port.getStrategy(FIXTURE_CAMPAIGN_IDS.live));
    render(<StrategyPanel view={view} />);

    for (const claim of view.claims) {
      const node = document.querySelector(`[data-claim-confidence="${claim.confidence}"]`);
      expect(node).not.toBeNull();
    }
    expect(screen.getAllByText(/Beleg:/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/darf ausschließlich als Hypothese kommuniziert werden/).length,
    ).toBeGreaterThan(0);
  });

  it('names the similar past campaigns and the stated differentiation', async () => {
    const view = await required(port.getStrategy(FIXTURE_CAMPAIGN_IDS.live));
    render(<StrategyPanel view={view} />);

    for (const similar of view.similarPastCampaigns) {
      expect(screen.getByText(similar.campaignName)).toBeInTheDocument();
    }
    expect(screen.getByText('Abgrenzung zu diesen Kampagnen')).toBeInTheDocument();
    expect(screen.getByText(view.differentiationFromPast)).toBeInTheDocument();
    expect(screen.getAllByText(view.risks[0]).length).toBeGreaterThan(0);
  });
});

describe('Funnel tab', () => {
  it('links every variant to the builder route that owns it', async () => {
    const view = await required(port.getFunnelOverview(FIXTURE_CAMPAIGN_IDS.live));
    render(<FunnelList view={view} />);

    for (const variant of view.variants) {
      const link = screen
        .getAllByRole('link', { name: /Im Builder öffnen/ })
        .find((node) => node.getAttribute('href') === variant.builderHref);
      expect(link, `no builder link for ${variant.name}`).toBeDefined();
      expect(variant.builderHref).toMatch(/^\/builder\/(form|page)\//);
    }
    expect(
      screen.getByText(
        new RegExp(`Mindestens ${GENERATION_DEFAULTS.minMultiStepFormVariants} Varianten`),
      ),
    ).toBeInTheDocument();
  });
});

describe('Testplan tab', () => {
  it('renders the variable, control, metrics, volume, runtime and rules', async () => {
    const view = await required(port.getTestPlan(FIXTURE_CAMPAIGN_IDS.live));
    render(<TestPlanPanel view={view} />);

    expect(screen.getByText(view.plan.testVariable)).toBeInTheDocument();
    expect(screen.getByText(view.armLabelsDe[view.plan.controlKey])).toBeInTheDocument();
    expect(screen.getByText('Primärmetrik')).toBeInTheDocument();
    expect(screen.getByText('Guardrail-Metriken')).toBeInTheDocument();
    expect(
      screen.getByText(
        `${view.plan.minSessionsPerArm} Sessions und ${view.plan.minConversionsPerArm} Conversions`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `${view.plan.crmMaturityDays} Tage, bevor CRM-Ergebnisse dieser Kohorte als belastbar gelten`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(view.plan.stopRules[0])).toBeInTheDocument();
    expect(screen.getByText(view.plan.scaleRules[0])).toBeInTheDocument();
  });
});

describe('Live-Performance tab', () => {
  it('renders totals and both breakdowns for a delivering campaign', async () => {
    const view = await required(port.getLivePerformance(FIXTURE_CAMPAIGN_IDS.live));
    render(<PerformancePanel view={view} />);

    expect(screen.getByText('Nach Creative')).toBeInTheDocument();
    expect(screen.getByText('Nach Funnelarm')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-breakdown-row]').length).toBe(
      view.byCreative.length + view.byFunnelArm.length,
    );
    // Every tile renders its basis, never a bare number.
    expect(document.querySelectorAll('[data-metric]').length).toBe(view.totals.length);
    expect(document.querySelectorAll('[data-am-metric-basis]').length).toBe(view.totals.length);
  });

  it('explains the absence of data rather than drawing an empty chart', async () => {
    const view = await required(port.getLivePerformance(FIXTURE_CAMPAIGN_IDS.metaDraft));
    render(<PerformancePanel view={view} />);

    expect(screen.getByText('Noch keine Auslieferung.')).toBeInTheDocument();
    expect(screen.getByText(/liefert nichts aus/)).toBeInTheDocument();
  });
});

describe('Leads & Sales tab', () => {
  it('renders the whole CRM funnel with maturity and attribution at every stage', async () => {
    const view = await required(port.getLeadsAndSales(FIXTURE_CAMPAIGN_IDS.live));
    render(<CrmPanel view={view} canRetry retry={vi.fn()} />);

    for (const stage of view.stages) {
      const node = document.querySelector(`[data-crm-stage="${stage.key}"]`);
      expect(node, `missing stage ${stage.key}`).not.toBeNull();
      expect(node?.querySelector('[data-maturity]')).not.toBeNull();
      expect(node?.querySelector('[data-am-rate-basis]')).not.toBeNull();
    }
    expect(screen.getByText('Attribuierter Umsatz')).toBeInTheDocument();
  });

  it('offers a retry only for a lead whose sync actually failed', async () => {
    const view = await required(port.getLeadsAndSales(FIXTURE_CAMPAIGN_IDS.live));
    render(<CrmPanel view={view} canRetry retry={vi.fn()} />);

    expect(view.failedSyncCount).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Erneut übertragen/ })).toHaveLength(
      view.failedSyncCount,
    );
  });

  it('names the responsible role instead of a dead retry button', async () => {
    const view = await required(port.getLeadsAndSales(FIXTURE_CAMPAIGN_IDS.live));
    render(<CrmPanel view={view} canRetry={false} retry={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Erneut übertragen/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/erfordert die Rolle RevOps/).length).toBe(view.failedSyncCount);
  });
});

describe('Learnings tab', () => {
  it('labels every card FACT, INDICATION or HYPOTHESIS', async () => {
    const cards = await port.getLearnings(FIXTURE_CAMPAIGN_IDS.completed);
    render(<LearningList cards={cards} />);

    for (const card of cards) {
      expect(document.querySelector(`[data-learning="${card.id}"]`)).toHaveAttribute(
        'data-confidence',
        card.confidence,
      );
    }
    expect(screen.getAllByText('Hypothese').length).toBeGreaterThan(0);
  });

  it('says so plainly when nothing has been learned yet', async () => {
    const cards = await port.getLearnings(FIXTURE_CAMPAIGN_IDS.strategyReview);
    render(<LearningList cards={cards} />);

    expect(screen.getByText('Noch keine Learnings.')).toBeInTheDocument();
  });
});

describe('Versionen tab', () => {
  it('renders version history and the audit log with before/after diffs', async () => {
    const view = await required(port.getHistory(FIXTURE_CAMPAIGN_IDS.live));
    render(<VersionHistory view={view} />);

    expect(document.querySelectorAll('[data-version]')).toHaveLength(view.versions.length);
    expect(document.querySelectorAll('[data-audit-action]').length).toBe(view.auditLog.length);
    expect(screen.getAllByText('Vorher').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nachher').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Geändert').length).toBeGreaterThan(0);
  });
});
