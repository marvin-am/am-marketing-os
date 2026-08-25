import * as React from 'react';
import type { MetricKey } from '@am/domain';
import { PageHeader, Section } from '@am/ui';
import { BreakdownTabs } from '@/components/analytics/breakdown-tabs';
import { CrmDelayNotice } from '@/components/analytics/crm-delay-notice';
import { DEFAULT_PRESET_ID, resolveRange } from '@/components/analytics/date-range';
import { FunnelDropOffView } from '@/components/analytics/funnel-dropoff';
import { MetricGrid } from '@/components/analytics/metric-grid';
import { PerformanceFilters } from '@/components/analytics/performance-filters';
import { TimeSeriesChart } from '@/components/analytics/time-series-chart';
import { requireUser } from '@/lib/action';
import { formatDate, formatNumber } from '@/lib/format';
import { clampRangeToHistory, createAnalyticsFixturePort } from '@/server/analytics-fixtures';

/**
 * Performance — the whole funnel in one view.
 *
 * Every figure on this page is read from pre-aggregated rollups. No provider API
 * is called on a page request: an insights call here would make the numbers
 * depend on when somebody hit reload, and would put a dashboard on Meta's rate
 * limit. The port in `server/analytics-port.ts` makes that a contract rather
 * than a habit.
 */

/** Delivery and first-party funnel metrics — complete within hours. */
const DELIVERY_METRICS: readonly MetricKey[] = [
  'spend',
  'impressions',
  'link_clicks',
  'ctr',
  'cpc',
  'cpm',
];

const FUNNEL_METRICS: readonly MetricKey[] = [
  'funnel_sessions',
  'form_start_rate',
  'step_dropoff',
  'leads',
  'submission_rate',
  'cpl',
];

/** CRM-delayed metrics. Everything here is qualified by the notice above it. */
const BUSINESS_METRICS: readonly MetricKey[] = [
  'vq_scheduled',
  'vq_scheduled_rate',
  'show_rate',
  'qualified_vq',
  'qualified_vq_rate',
  'cost_per_qualified_vq',
  'opportunities',
  'opportunity_rate',
  'closed_won',
  'close_rate',
  'cac',
  'revenue',
  'roas',
];

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  await requireUser('campaign.read');

  const params = await searchParams;
  const now = new Date().toISOString();
  const port = createAnalyticsFixturePort({ now });

  const selection = resolveRange(
    {
      zeitraum: firstParam(params.zeitraum),
      von: firstParam(params.von),
      bis: firstParam(params.bis),
    },
    now,
  );
  const range = clampRangeToHistory(selection.range, now);
  const campaignId = firstParam(params.kampagne) ?? null;
  const funnelVersionId = firstParam(params.funnel) ?? null;

  const [campaigns, funnelVersions, overview, breakdowns, dropOff] = await Promise.all([
    port.listCampaigns(),
    port.listFunnelVersions(),
    port.getPerformanceOverview({ range, campaignId, now }),
    port.getBreakdowns({ range, campaignId, now }),
    port.getFunnelDropOff({ range, campaignId, funnelVersionId, now }),
  ]);

  const earliest = campaigns.reduce(
    (min, campaign) => (campaign.firstDay < min ? campaign.firstDay : min),
    range.from,
  );
  const activeCampaign = campaigns.find((campaign) => campaign.id === campaignId);
  const noShows = overview.total.counters.vqScheduled - overview.total.counters.vqAttended;
  const openOpportunities = overview.total.counters.opportunities - overview.total.counters.closedWon;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Performance"
        description={
          <>
            Der vollständige Funnel für {activeCampaign ? activeCampaign.labelDe : 'alle Kampagnen'} vom{' '}
            {formatDate(range.from)} bis {formatDate(range.to)}. Jede Kennzahl steht mit ihrer
            Bezugsgröße, ihrer Datenreife und — wo sie auf Zuordnung beruht — ihrer
            Attributionsabdeckung.
          </>
        }
        toolbar={
          <PerformanceFilters
            basePath="/performance"
            presetId={selection.presetId || DEFAULT_PRESET_ID}
            range={range}
            campaigns={campaigns}
            campaignId={campaignId}
            funnelVersions={funnelVersions}
            funnelVersionId={funnelVersionId}
            minDate={earliest}
            maxDate={range.to}
          />
        }
      />

      <Section
        heading="Auslieferung"
        description="Meta-Insights des Zeitraums. Diese Werte sind innerhalb von Stunden vollständig."
      >
        <MetricGrid snapshot={overview.total} keys={DELIVERY_METRICS} columns={3} />
      </Section>

      <Section
        heading="Funnel und Leads"
        description="Erstparteiische Funnel-Daten. Nur PRODUCTION-Traffic wird gezählt; Vorschau-, Bot-, interner und Test-Traffic bleibt außen vor."
      >
        <MetricGrid snapshot={overview.total} keys={FUNNEL_METRICS} columns={3} />
        <p className="text-xs text-muted-foreground">
          Vor der Auswertung ausgeschlossen:{' '}
          <span data-am-numeric="">{formatNumber(overview.exclusions.events)}</span> Ereignisse und{' '}
          <span data-am-numeric="">{formatNumber(overview.exclusions.crmRecords)}</span>{' '}
          CRM-Datensätze aus nicht-produktivem Traffic.
        </p>
      </Section>

      <Section
        heading="Vertrieb und Umsatz"
        description="Diese Kennzahlen entstehen erst im CRM und laufen dem Zeitraum hinterher."
      >
        <CrmDelayNotice statement={overview.crmDelay} snapshot={overview.total} />
        <MetricGrid snapshot={overview.total} keys={BUSINESS_METRICS} columns={3} />
        <p className="text-xs text-muted-foreground">
          Abgeleitet aus denselben Zählern:{' '}
          <span data-am-numeric="">{formatNumber(noShows)}</span> No-Shows (terminierte minus
          stattgefundene VQs) und <span data-am-numeric="">{formatNumber(openOpportunities)}</span>{' '}
          Opportunities, die noch offen oder verloren sind (Opportunities minus Abschlüsse).
        </p>
      </Section>

      <Section
        heading="Verlauf"
        description="Drei Kennzahlen, drei Diagramme. Zwei Größenordnungen auf einer Achse würden einen Zusammenhang erfinden, den die Daten nicht hergeben."
      >
        <div className="grid gap-4 xl:grid-cols-3">
          <TimeSeriesChart
            titleDe="Spend je Tag"
            points={overview.series}
            metric="spend"
            seriesIndex={0}
          />
          <TimeSeriesChart
            titleDe="Leads je Tag"
            points={overview.series}
            metric="leads"
            seriesIndex={2}
          />
          <TimeSeriesChart
            titleDe="CPL je Tag"
            points={overview.series}
            metric="cpl"
            seriesIndex={1}
            shape="line"
            descriptionDe="Spend / Leads. Tage ohne Lead haben keinen Nenner und werden als Lücke dargestellt, nicht als 0 €."
          />
        </div>
      </Section>

      <Section
        heading="Aufschlüsselung"
        description="Dieselbe Auswahl nach Kampagne, Creative, Funnel-Version und Experimentarm."
      >
        <BreakdownTabs breakdowns={breakdowns} />
      </Section>

      <FunnelDropOffView dropOff={dropOff} />
    </div>
  );
}
