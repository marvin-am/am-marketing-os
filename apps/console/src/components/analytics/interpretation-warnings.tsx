import * as React from 'react';
import { METRIC_CATALOG, type MetricKey } from '@am/domain';
import { EXPERIMENT_WARNING_LABELS_DE } from '@am/experiments';
import { Alert, AlertDescription, AlertTitle } from '@am/ui';
import { TriangleAlert } from 'lucide-react';

/** Short German headline per warning, so the alert is scannable. */
const WARNING_HEADLINES_DE: Readonly<Record<string, string>> = {
  BUNDLED_CREATIVE_AND_FUNNEL_CONFOUNDED: 'Gebündelter Test — Ursache nicht zuordenbar',
  ELIGIBILITY_CHANGING_NOT_A_CONVERSION_TEST: 'Kein reiner Conversion-Test',
  META_OPTIMISED_DELIVERY_NOT_RANDOMISED: 'Kein randomisierter A/B-Test',
  CONVERSIONS_EXCEED_DENOMINATOR: 'Inkonsistente Rohdaten',
  LOW_ATTRIBUTION_COVERAGE: 'Geringe Attributionsabdeckung',
  CRM_PRIMARY_METRIC_WITH_IMMATURE_DATA: 'Primärmetrik hängt an unreifen CRM-Daten',
  REVENUE_METRIC_NEEDS_SEPARATE_EVALUATION: 'Umsatzmetrik gesondert bewerten',
  PRIMARY_METRIC_NOT_A_CONVERSION_RATE: 'Primärmetrik ist keine Conversion-Rate',
  WIN_PROBABILITY_WITHIN_NUMERICAL_TOLERANCE: 'Entscheidung zu knapp',
  UNEQUAL_TRAFFIC_SPLIT: 'Ungleiche Traffic-Verteilung',
};

function guardrailMetric(code: string): MetricKey | null {
  if (!code.startsWith('GUARDRAIL_BREACH:')) return null;
  const key = code.slice('GUARDRAIL_BREACH:'.length);
  return key in METRIC_CATALOG ? (key as MetricKey) : null;
}

export function warningHeadlineDe(code: string): string {
  const metric = guardrailMetric(code);
  if (metric) return `Guardrail verletzt: ${METRIC_CATALOG[metric].label}`;
  return WARNING_HEADLINES_DE[code] ?? 'Einschränkung der Interpretierbarkeit';
}

export function warningBodyDe(code: string): string {
  const metric = guardrailMetric(code);
  if (metric) {
    return `Die Guardrail-Metrik ${METRIC_CATALOG[metric].label} hat ihr Limit verletzt. Das Ergebnis ist unabhängig vom Urteil des Primärtests gesondert zu prüfen.`;
  }
  const known = (EXPERIMENT_WARNING_LABELS_DE as Readonly<Record<string, string>>)[code];
  return known ?? `Unbekannter Warnhinweis: ${code}`;
}

export interface InterpretationWarningsProps {
  codes: readonly string[];
  /** Compact rendering for list rows. */
  variant?: 'full' | 'compact';
}

/**
 * Every `interpretationWarnings` entry, rendered prominently.
 *
 * These are not footnotes. A bundled test can produce a statistically clean
 * winner and still be unable to say *what* won; an eligibility-changing test
 * compares different populations; a CREATIVE_EXPLORATION is not randomised at
 * all because Meta decides the delivery. A reader who sees the verdict without
 * these has been misled.
 */
export function InterpretationWarnings({
  codes,
  variant = 'full',
}: InterpretationWarningsProps): React.JSX.Element | null {
  if (codes.length === 0) return null;

  if (variant === 'compact') {
    return (
      <ul className="flex flex-col gap-1">
        {codes.map((code) => (
          <li key={code} className="inline-flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{warningHeadlineDe(code)}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {codes.map((code) => (
        <Alert key={code} tone="warning" data-warning-code={code}>
          <AlertTitle className="text-sm font-semibold">{warningHeadlineDe(code)}</AlertTitle>
          <AlertDescription className="text-sm leading-relaxed text-foreground">
            {warningBodyDe(code)}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
