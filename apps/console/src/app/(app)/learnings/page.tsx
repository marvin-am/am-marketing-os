import * as React from 'react';
import { CONFIDENCE_LABELS_DE, type ConfidenceLabel } from '@am/domain';
import { PageHeader, Section } from '@am/ui';
import { LearningsBrowser } from '@/components/analytics/learnings-browser';
import { requireUser } from '@/lib/action';
import { formatNumber } from '@/lib/format';
import { createAnalyticsFixturePort } from '@/server/analytics-fixtures';

/**
 * Learnings — the distilled memory of what was tested.
 *
 * A learning card is only ever as strong as the data behind it, and the label
 * that says so is computed from data maturity, attribution coverage and sample
 * size. The model may write the prose; it may never upgrade the label.
 */

export default async function LearningsPage(): Promise<React.JSX.Element> {
  await requireUser('campaign.read');

  const port = createAnalyticsFixturePort();
  const cards = await port.listLearningCards();

  const counts = cards.reduce<Record<ConfidenceLabel, number>>(
    (acc, card) => ({ ...acc, [card.confidence]: acc[card.confidence] + 1 }),
    { FACT: 0, INDICATION: 0, HYPOTHESIS: 0 },
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Learnings"
        description={
          <>
            <span data-am-numeric="">{formatNumber(cards.length)}</span> Karten:{' '}
            <span data-am-numeric="">{formatNumber(counts.FACT)}</span> {CONFIDENCE_LABELS_DE.FACT},{' '}
            <span data-am-numeric="">{formatNumber(counts.INDICATION)}</span>{' '}
            {CONFIDENCE_LABELS_DE.INDICATION} und{' '}
            <span data-am-numeric="">{formatNumber(counts.HYPOTHESIS)}</span>{' '}
            {CONFIDENCE_LABELS_DE.HYPOTHESIS}. Die Belegstärke wird aus Datenreife,
            Attributionsabdeckung und Stichprobengröße berechnet — sie wird nicht behauptet.
          </>
        }
      />

      <Section
        heading="Learning-Karten"
        description="Jede Karte hält fest, was getestet wurde, unter welchem Angle und Offer, mit welchem Creative-Konzept, Funnel-Typ und welcher Zielgruppe — und wie belastbar das Ergebnis ist."
      >
        <LearningsBrowser cards={cards} />
      </Section>
    </div>
  );
}
