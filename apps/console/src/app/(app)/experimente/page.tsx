import * as React from 'react';
import { PageHeader, Section } from '@am/ui';
import { ExperimentList } from '@/components/analytics/experiment-list';
import { requireUser } from '@/lib/action';
import { formatNumber } from '@/lib/format';
import { createAnalyticsFixturePort } from '@/server/analytics-fixtures';

/**
 * Experimente — every test with its verdict, told honestly.
 *
 * The list is deliberately verdict-first and warning-second: a reader scanning
 * it must not be able to see "Gewinner" without also seeing whether the design
 * allows that conclusion at all.
 */

export default async function ExperimentsPage(): Promise<React.JSX.Element> {
  await requireUser('campaign.read');

  const now = new Date().toISOString();
  const port = createAnalyticsFixturePort({ now });
  const experiments = await port.listExperiments(now);

  const running = experiments.filter((entry) => entry.experiment.state === 'RUNNING').length;
  const concluded = experiments.filter((entry) => entry.experiment.state === 'CONCLUDED').length;
  const withWarnings = experiments.filter(
    (entry) => entry.evaluation.result.interpretationWarnings.length > 0,
  ).length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Experimente"
        description={
          <>
            <span data-am-numeric="">{formatNumber(experiments.length)}</span> Tests, davon{' '}
            <span data-am-numeric="">{formatNumber(running)}</span> laufend und{' '}
            <span data-am-numeric="">{formatNumber(concluded)}</span> abgeschlossen.{' '}
            <span data-am-numeric="">{formatNumber(withWarnings)}</span> tragen Hinweise, die die
            Interpretierbarkeit ihres Ergebnisses einschränken.
          </>
        }
      />

      <Section
        heading="Alle Experimente"
        description="Ein Urteil entsteht erst, wenn Laufzeit, Sessions und Conversions je Arm die hinterlegten Schwellen erreichen. „Vorläufig führend“ ist kein Gewinner."
      >
        <ExperimentList experiments={experiments} />
      </Section>
    </div>
  );
}
