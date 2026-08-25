import type { LearningCard } from '@am/domain';
import {
  AttributionCoverageBadge,
  Badge,
  ConfidenceBadge,
  DataMaturityBadge,
  EmptyState,
  formatMoneyMinorDe,
  formatPercentDe,
  Section,
} from '@am/ui';
import { formatDate, formatNumber } from '@/lib/format';
import { ATTRIBUTION_LEVEL_LABELS_DE, FUNNEL_KIND_LABELS_DE } from './labels';

/**
 * Learning cards, each carrying its computed confidence label.
 *
 * The label is derived from data maturity, attribution coverage and sample
 * size — never asserted. A HYPOTHESIS card is as valuable as a FACT card as
 * long as nobody mistakes one for the other (spec §11, §4.4).
 */
export function LearningList({ cards }: { cards: LearningCard[] }) {
  if (cards.length === 0) {
    return (
      <EmptyState
        title="Noch keine Learnings."
        description="Learnings entstehen aus abgeschlossenen Experimenten und aus reifen Kohorten laufender Kampagnen. Solange keine Kohorte reif ist, wird bewusst nichts behauptet."
      />
    );
  }

  return (
    <Section
      heading={`Learnings (${cards.length})`}
      description="Sortiert nach Belegstärke: Fakt, Indikation, Hypothese."
    >
      <ul className="flex flex-col gap-4">
        {[...cards]
          .sort((a, b) => rank(a.confidence) - rank(b.confidence))
          .map((card) => (
            <li
              key={card.id}
              data-learning={card.id}
              data-confidence={card.confidence}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
            >
              <header className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-sm font-semibold text-foreground">{card.titleDe}</h3>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="outline" size="sm">
                      Version {card.version}
                    </Badge>
                    <Badge tone="neutral" size="sm">
                      Erstellt am {formatDate(card.created_at)}
                    </Badge>
                    {card.funnelKind ? (
                      <Badge tone="neutral" size="sm">
                        {FUNNEL_KIND_LABELS_DE[card.funnelKind]}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <ConfidenceBadge confidence={card.confidence} />
              </header>

              <dl className="grid gap-3 sm:grid-cols-2">
                <Field label="Was getestet wurde">{card.whatWasTestedDe}</Field>
                <Field label="Ergebnis">{card.outcomeDe}</Field>
                <Field label="Angle / Offer">
                  {card.angleName ?? '–'} · {card.offerName ?? '–'}
                </Field>
                <Field label="Zielgruppe">{card.audienceDe ?? '–'}</Field>
              </dl>

              {card.outcomeFacts.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    Zahlen
                  </p>
                  <ul className="flex flex-col gap-1">
                    {card.outcomeFacts.map((fact) => (
                      <li
                        key={fact.label}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm"
                      >
                        <span className="text-foreground">{fact.label}</span>
                        <span data-am-numeric="" className="font-medium tabular-nums text-foreground">
                          {fact.unit === 'RATE' ? formatPercentDe(fact.value) : formatNumber(fact.value)}
                        </span>
                        {fact.numerator !== null && fact.denominator !== null ? (
                          <span
                            data-am-rate-basis=""
                            className="text-xs tabular-nums text-muted-foreground"
                          >
                            {formatNumber(fact.numerator)} / {formatNumber(fact.denominator)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <DataMaturityBadge maturity={card.dataMaturity} />
                <AttributionCoverageBadge coverage={card.attributionCoverage} />
                <Badge tone="outline" size="sm">
                  Attribution: {ATTRIBUTION_LEVEL_LABELS_DE[card.attributionLevel]}
                </Badge>
                <Badge tone="neutral" size="sm">
                  Spend {formatMoneyMinorDe(card.spendMinor, card.currency)}
                </Badge>
              </div>

              {card.possibleExplanationDe ? (
                <Field label="Mögliche Erklärung">{card.possibleExplanationDe}</Field>
              ) : null}
              {card.suggestedNextTestDe ? (
                <Field label="Vorgeschlagener nächster Test">{card.suggestedNextTestDe}</Field>
              ) : null}
            </li>
          ))}
      </ul>
    </Section>
  );
}

function rank(confidence: LearningCard['confidence']): number {
  return confidence === 'FACT' ? 0 : confidence === 'INDICATION' ? 1 : 2;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}
