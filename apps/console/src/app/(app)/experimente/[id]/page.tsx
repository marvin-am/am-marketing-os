import * as React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EXPERIMENT_KIND_LABELS_DE, METRIC_CATALOG } from '@am/domain';
import {
  AttributionCoverageBadge,
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  PageHeader,
  Section,
  StatusBadge,
} from '@am/ui';
import {
  ExperimentArmMetricsTable,
  ExperimentArmsTable,
} from '@/components/analytics/experiment-arms-table';
import { ExperimentVerdictBadge, ExperimentVerdictPanel } from '@/components/analytics/experiment-verdict';
import { requireUser } from '@/lib/action';
import { formatCurrencyMinor, formatDate, formatDuration, formatNumber } from '@/lib/format';
import { createAnalyticsFixturePort } from '@/server/analytics-fixtures';

function Detail({ labelDe, children }: { labelDe: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labelDe}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

/**
 * One experiment in full.
 *
 * The order is the order a reader has to take it in: what the design allows to
 * be concluded, then the verdict and the thresholds behind it, then the arms.
 * Nothing on this page states a result the design cannot support.
 */
export default async function ExperimentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  await requireUser('campaign.read');

  const { id } = await params;
  const now = new Date().toISOString();
  const port = createAnalyticsFixturePort({ now });
  const detail = await port.getExperiment(id, now);
  if (!detail) notFound();

  const { experiment, evaluation, observations, arms, armMetrics } = detail;
  const result = evaluation.result;
  const totalSpend = observations.reduce((sum, observation) => sum + observation.spend_minor, 0);
  const coverages = observations
    .map((observation) => observation.attribution_coverage)
    .filter((value): value is number => value !== null && value !== undefined);
  const averageCoverage =
    coverages.length > 0 ? coverages.reduce((sum, value) => sum + value, 0) / coverages.length : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href="/experimente">Experimente</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{experiment.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
        title={experiment.name}
        meta={
          <>
            <StatusBadge kind="experiment" state={experiment.state} />
            <Badge tone="outline">{EXPERIMENT_KIND_LABELS_DE[experiment.kind]}</Badge>
            <ExperimentVerdictBadge verdict={result.verdict} />
          </>
        }
        description={experiment.hypothesis}
      />

      <Section heading="Aufbau">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Detail labelDe="Kampagne">{detail.campaignLabelDe}</Detail>
          <Detail labelDe="Testvariable">{experiment.test_variable}</Detail>
          <Detail labelDe="Primärmetrik">
            {METRIC_CATALOG[experiment.primary_metric].label}
            <span className="block text-xs text-muted-foreground">
              {METRIC_CATALOG[experiment.primary_metric].formula}
            </span>
          </Detail>
          <Detail labelDe="Laufzeit">
            <span data-am-numeric="">{formatDuration(result.runtimeDays)}</span>
            <span className="block text-xs text-muted-foreground" data-am-numeric="">
              {formatDate(experiment.started_at)}
              {experiment.concluded_at ? ` – ${formatDate(experiment.concluded_at)}` : ' – laufend'}
            </span>
          </Detail>
          <Detail labelDe="Sekundärmetriken">
            {experiment.secondary_metrics.length === 0
              ? '–'
              : experiment.secondary_metrics.map((key) => METRIC_CATALOG[key].label).join(', ')}
          </Detail>
          <Detail labelDe="Guardrails">
            {experiment.guardrail_metrics.length === 0
              ? '–'
              : experiment.guardrail_metrics.map((key) => METRIC_CATALOG[key].label).join(', ')}
          </Detail>
          <Detail labelDe="Spend im Test">
            <span data-am-numeric="">{formatCurrencyMinor(totalSpend)}</span>
          </Detail>
          <Detail labelDe="Attributionsabdeckung">
            <AttributionCoverageBadge coverage={averageCoverage} withHint={false} />
          </Detail>
          <Detail labelDe="Sessions gesamt">
            <span data-am-numeric="">{formatNumber(result.totalSessions)}</span>
          </Detail>
          <Detail labelDe="Conversions gesamt">
            <span data-am-numeric="">{formatNumber(result.totalConversions)}</span>
          </Detail>
          <Detail labelDe="Gebündelt">{experiment.bundled ? 'Ja' : 'Nein'}</Detail>
          <Detail labelDe="Zulassung verändert">
            {experiment.eligibility_changing ? 'Ja' : 'Nein'}
          </Detail>
        </dl>
      </Section>

      <Section
        heading="Urteil"
        description="Volumenschwellen zuerst, Statistik danach, Datenreife zuletzt — und die Reife kann ein Urteil nur abwerten, nie aufwerten."
      >
        <ExperimentVerdictPanel
          result={result}
          observations={observations}
          maturity={evaluation.maturity}
          winningArmLabelDe={detail.winningArmLabelDe}
        />
      </Section>

      <Section
        heading="Ergebnisse je Arm"
        description="Conversion-Raten stehen mit Zähler und Nenner. Ein Arm unterhalb der Mindestvolumina wird als solcher markiert und trägt kein Ergebnis."
      >
        <ExperimentArmsTable
          arms={result.arms}
          observations={observations}
          thresholds={result.thresholds}
          leadingArmId={evaluation.leadingArmId}
          winningArmId={result.verdict === 'WINNER' ? result.winning_arm_id : null}
        />
      </Section>

      <Section
        heading="Kennzahlen je Arm"
        description="Dieselben Kennzahlen wie in der Performance-Auswertung, je Arm — mit Datenreife und Attributionsabdeckung."
      >
        <ExperimentArmMetricsTable arms={arms} armMetrics={armMetrics} />
      </Section>
    </div>
  );
}
