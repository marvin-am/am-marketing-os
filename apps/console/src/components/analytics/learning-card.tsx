import * as React from 'react';
import {
  ATTRIBUTION_LEVEL_LABELS_DE,
  CONFIDENCE_LABELS_DE,
  type LearningCard,
} from '@am/domain';
import {
  AttributionCoverageBadge,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfidenceBadge,
  CONFIDENCE_EXPLANATIONS_DE,
  DataMaturityBadge,
} from '@am/ui';
import { formatCurrencyMinor, formatDate, formatNumber, formatPercent, MATURITY_EXPLANATION_DE } from '@/lib/format';
import { FUNNEL_KIND_LABELS_DE } from './labels';

export interface LearningCardViewProps {
  card: LearningCard;
}

function FactLine({ fact }: { fact: LearningCard['outcomeFacts'][number] }): React.JSX.Element {
  const hasBasis = fact.numerator !== null && fact.denominator !== null;
  const display =
    fact.unit === '%' ? formatPercent(fact.value) : fact.value === null ? '–' : formatNumber(fact.value, 2);

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border py-1.5 last:border-0">
      <span className="text-sm text-muted-foreground">{fact.label}</span>
      <span className="text-right">
        <span data-am-numeric="" className="text-sm font-medium text-foreground">
          {display}
        </span>
        {hasBasis ? (
          <span data-am-numeric="" className="ml-2 text-xs text-muted-foreground">
            {formatNumber(fact.numerator)} / {formatNumber(fact.denominator)}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function Detail({ labelDe, children }: { labelDe: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labelDe}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

/**
 * One learning card.
 *
 * The confidence label is computed from data maturity, attribution coverage and
 * sample size — never asserted by the model — so the card always shows what the
 * label means next to it. A HYPOTHESIS card is a thing to test, not a thing to
 * report, and it says so in German rather than relying on a badge colour.
 */
export function LearningCardView({ card }: LearningCardViewProps): React.JSX.Element {
  return (
    <Card data-confidence={card.confidence} data-learning-id={card.id}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="text-base">{card.titleDe}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <ConfidenceBadge confidence={card.confidence} />
            <DataMaturityBadge maturity={card.dataMaturity} withHint={false} />
            <AttributionCoverageBadge coverage={card.attributionCoverage} withHint={false} />
          </div>
        </div>
        <p className="rounded-md bg-surface-raised px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <strong className="text-foreground">{CONFIDENCE_LABELS_DE[card.confidence]}:</strong>{' '}
          {CONFIDENCE_EXPLANATIONS_DE[card.confidence]}
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Was getestet wurde
          </h4>
          <p className="text-sm leading-relaxed text-foreground">{card.whatWasTestedDe}</p>
        </section>

        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Detail labelDe="Angle">{card.angleName ?? '–'}</Detail>
          <Detail labelDe="Offer">{card.offerName ?? '–'}</Detail>
          <Detail labelDe="Creative-Konzept">{card.creativeConceptDe ?? '–'}</Detail>
          <Detail labelDe="Funnel-Typ">
            {card.funnelKind ? FUNNEL_KIND_LABELS_DE[card.funnelKind] : '–'}
          </Detail>
          <Detail labelDe="Zielgruppe">{card.audienceDe ?? '–'}</Detail>
          <Detail labelDe="Zeitraum">
            <span data-am-numeric="">
              {formatDate(card.periodStart)} – {formatDate(card.periodEnd)}
            </span>
          </Detail>
          <Detail labelDe="Spend">
            <span data-am-numeric="">{formatCurrencyMinor(card.spendMinor, card.currency)}</span>
          </Detail>
          <Detail labelDe="Attributionsebene">
            <Badge tone="outline" size="sm">
              {ATTRIBUTION_LEVEL_LABELS_DE[card.attributionLevel]}
            </Badge>
          </Detail>
          <Detail labelDe="Datenreife">
            <span className="text-xs text-muted-foreground">
              {MATURITY_EXPLANATION_DE[card.dataMaturity]}
            </span>
          </Detail>
        </dl>

        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Ergebnis
          </h4>
          <p className="text-sm leading-relaxed text-foreground">{card.outcomeDe}</p>
          {card.outcomeFacts.length > 0 ? (
            <ul className="mt-1 flex flex-col">
              {card.outcomeFacts.map((fact) => (
                <FactLine key={fact.label} fact={fact} />
              ))}
            </ul>
          ) : null}
        </section>

        {card.possibleExplanationDe ? (
          <section className="flex flex-col gap-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Mögliche Erklärung
            </h4>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {card.possibleExplanationDe}
            </p>
          </section>
        ) : null}

        {card.suggestedNextTestDe ? (
          <section className="flex flex-col gap-1 rounded-md border border-border bg-surface-raised p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Vorgeschlagener nächster Test
            </h4>
            <p className="text-sm leading-relaxed text-foreground">{card.suggestedNextTestDe}</p>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
