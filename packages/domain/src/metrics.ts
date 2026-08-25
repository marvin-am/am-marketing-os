import { z } from 'zod';
import { dataMaturitySchema } from './enums';
import { moneySchema } from './primitives';

/**
 * Metric catalogue.
 *
 * Every metric that the product may set as a primary, secondary or guardrail
 * metric lives here. The AI layer chooses *from* this list — it can never
 * invent a metric key, because the schema rejects anything else.
 */
export const METRIC_KEYS = [
  // Leading indicators — available within hours.
  'impressions',
  'link_clicks',
  'ctr',
  'cpc',
  'cpm',
  'spend',
  'funnel_sessions',
  'form_start_rate',
  'step_dropoff',
  'submission_rate',
  'leads',
  'cpl',
  // Business indicators — delayed by the CRM cycle.
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
] as const;
export const metricKeySchema = z.enum(METRIC_KEYS);
export type MetricKey = z.infer<typeof metricKeySchema>;

export const METRIC_UNITS = ['COUNT', 'RATE', 'MONEY', 'RATIO'] as const;
export const metricUnitSchema = z.enum(METRIC_UNITS);
export type MetricUnit = z.infer<typeof metricUnitSchema>;

export const METRIC_DIRECTIONS = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'] as const;
export const metricDirectionSchema = z.enum(METRIC_DIRECTIONS);
export type MetricDirection = z.infer<typeof metricDirectionSchema>;

/** How long real-world data typically takes to be trustworthy. */
export const METRIC_LATENCIES = ['IMMEDIATE', 'SHORT', 'CRM_DELAYED'] as const;
export const metricLatencySchema = z.enum(METRIC_LATENCIES);
export type MetricLatency = z.infer<typeof metricLatencySchema>;

/**
 * Whether the number rests on something observed or on something inferred.
 *
 * `DERIVED` exists because of one concrete case that would otherwise read as
 * fact: the CRM records no "the VQ call happened" event, so attendance is
 * inferred from the deal leaving the scheduled stage other than towards
 * no-show. A lead disqualified on paper, without a call ever taking place,
 * counts as attended under that rule. Show rate and qualification rate are
 * therefore estimates, and a dashboard that renders them identically to
 * measured numbers invites a decision they cannot carry.
 *
 * It is a property of the metric rather than a note in a document because the
 * marker has to travel with the number to wherever it is rendered.
 */
export const METRIC_MEASUREMENTS = ['MEASURED', 'DERIVED'] as const;
export const metricMeasurementSchema = z.enum(METRIC_MEASUREMENTS);
export type MetricMeasurement = z.infer<typeof metricMeasurementSchema>;

export const METRIC_MEASUREMENT_LABELS_DE: Readonly<Record<MetricMeasurement, string>> = {
  MEASURED: 'Gemessen',
  DERIVED: 'Abgeleitet',
};

export const metricDefinitionSchema = z.object({
  key: metricKeySchema,
  /** German label shown in the UI. */
  label: z.string().min(1),
  unit: metricUnitSchema,
  direction: metricDirectionSchema,
  latency: metricLatencySchema,
  /**
   * Defaults to `MEASURED`: a metric is an observation unless it says
   * otherwise, so adding one cannot silently introduce an unmarked estimate.
   */
  measurement: metricMeasurementSchema.default('MEASURED'),
  /** Optional numeric target the campaign is steered against. */
  target: z.number().nullable().default(null),
  /** Human-readable formula, always rendered next to the value. */
  formula: z.string().min(1),
});
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

export const METRIC_CATALOG: Readonly<Record<MetricKey, MetricDefinition>> = {
  impressions: { key: 'impressions', label: 'Impressionen', unit: 'COUNT', direction: 'HIGHER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'Meta Insights' },
  link_clicks: { key: 'link_clicks', label: 'Link-Klicks', unit: 'COUNT', direction: 'HIGHER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'Meta Insights' },
  ctr: { key: 'ctr', label: 'CTR', unit: 'RATE', direction: 'HIGHER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'Link-Klicks / Impressionen' },
  cpc: { key: 'cpc', label: 'CPC', unit: 'MONEY', direction: 'LOWER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'Spend / Link-Klicks' },
  cpm: { key: 'cpm', label: 'CPM', unit: 'MONEY', direction: 'LOWER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'Spend / Impressionen × 1.000' },
  spend: { key: 'spend', label: 'Spend', unit: 'MONEY', direction: 'LOWER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'Meta Insights' },
  funnel_sessions: { key: 'funnel_sessions', label: 'Funnel-Sessions', unit: 'COUNT', direction: 'HIGHER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'Eindeutige Sessions mit funnel_viewed' },
  form_start_rate: { key: 'form_start_rate', label: 'Formularstartrate', unit: 'RATE', direction: 'HIGHER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'form_started / Funnel-Sessions' },
  step_dropoff: { key: 'step_dropoff', label: 'Step-Abbruchrate', unit: 'RATE', direction: 'LOWER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: '1 − (Step abgeschlossen / Step gesehen)' },
  submission_rate: { key: 'submission_rate', label: 'Submission-Rate', unit: 'RATE', direction: 'HIGHER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'Leads / eindeutige Funnel-Sessions' },
  leads: { key: 'leads', label: 'Leads', unit: 'COUNT', direction: 'HIGHER_IS_BETTER', latency: 'IMMEDIATE', measurement: 'MEASURED', target: null, formula: 'Akzeptierte Submissions' },
  cpl: { key: 'cpl', label: 'CPL', unit: 'MONEY', direction: 'LOWER_IS_BETTER', latency: 'SHORT', measurement: 'MEASURED', target: null, formula: 'Spend / Leads' },
  vq_scheduled: { key: 'vq_scheduled', label: 'Terminierte VQs', unit: 'COUNT', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'CRM-Ereignis VQ_SCHEDULED' },
  vq_scheduled_rate: { key: 'vq_scheduled_rate', label: 'VQ-Terminierungsrate', unit: 'RATE', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'Terminierte VQs / Leads' },
  show_rate: { key: 'show_rate', label: 'Show-Rate', unit: 'RATE', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'DERIVED', target: null, formula: 'Stattgefundene VQs / terminierte VQs' },
  qualified_vq: { key: 'qualified_vq', label: 'Qualifizierte VQs', unit: 'COUNT', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'CRM-Ereignis VQ_PASSED' },
  qualified_vq_rate: { key: 'qualified_vq_rate', label: 'Qualifizierungsrate', unit: 'RATE', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'DERIVED', target: null, formula: 'Qualifizierte VQs / stattgefundene VQs' },
  cost_per_qualified_vq: { key: 'cost_per_qualified_vq', label: 'Kosten je qualifiziertem VQ', unit: 'MONEY', direction: 'LOWER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'Spend / qualifizierte VQs' },
  opportunities: { key: 'opportunities', label: 'Opportunities', unit: 'COUNT', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'CRM-Ereignis OPPORTUNITY_CREATED' },
  opportunity_rate: { key: 'opportunity_rate', label: 'Opportunity-Rate', unit: 'RATE', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'Opportunities / Leads' },
  closed_won: { key: 'closed_won', label: 'Abschlüsse', unit: 'COUNT', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'CRM-Ereignis CLOSED_WON' },
  close_rate: { key: 'close_rate', label: 'Abschlussquote', unit: 'RATE', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'Closed Won / Opportunities' },
  cac: { key: 'cac', label: 'CAC', unit: 'MONEY', direction: 'LOWER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'Spend / Closed Won' },
  /*
   * "Umsatz" would be a claim this number cannot support. The CRM carries the
   * contract value booked when a deal is won, not money collected; a lead that
   * signs and never pays is indistinguishable here. The label therefore names
   * what is actually measured, and recognised revenue stays a separate metric
   * that is empty until an invoicing source exists — never estimated from this
   * one.
   */
  revenue: { key: 'revenue', label: 'Gebuchter Vertragswert', unit: 'MONEY', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'Attribuierter gebuchter Vertragswert aus CLOSED_WON' },
  roas: { key: 'roas', label: 'ROAS (gebucht)', unit: 'RATIO', direction: 'HIGHER_IS_BETTER', latency: 'CRM_DELAYED', measurement: 'MEASURED', target: null, formula: 'Gebuchter Vertragswert / Spend' },
};

export const LEADING_METRIC_KEYS: readonly MetricKey[] = [
  'ctr',
  'cpc',
  'funnel_sessions',
  'form_start_rate',
  'step_dropoff',
  'submission_rate',
  'cpl',
];

export const BUSINESS_METRIC_KEYS: readonly MetricKey[] = [
  'vq_scheduled_rate',
  'show_rate',
  'qualified_vq_rate',
  'cost_per_qualified_vq',
  'opportunity_rate',
  'cac',
  'revenue',
  'roas',
];

/**
 * A computed rate. The numerator and denominator are always carried alongside
 * the value so the UI can render "12 / 340" next to "3,5 %"
 * (acceptance criterion 19). `value` is null for a zero denominator — never 0,
 * which would read as a real measurement.
 */
export const rateSchema = z.object({
  numerator: z.number(),
  denominator: z.number(),
  value: z.number().nullable(),
});
export type Rate = z.infer<typeof rateSchema>;

export function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    value: denominator > 0 ? numerator / denominator : null,
  };
}

/** A computed money-per-unit value, carrying its inputs for the same reason. */
export const costPerSchema = z.object({
  spend: moneySchema,
  units: z.number(),
  value: moneySchema.nullable(),
});
export type CostPer = z.infer<typeof costPerSchema>;

export function costPer(spendMinor: number, units: number, currency = 'EUR'): CostPer {
  return {
    spend: { amountMinor: spendMinor, currency },
    units,
    value: units > 0 ? { amountMinor: Math.round(spendMinor / units), currency } : null,
  };
}

/**
 * Every metric value shown in the product is wrapped in this envelope so the UI
 * can never display a number without its data-maturity context (spec §4.3).
 */
export const metricValueSchema = z.object({
  metric: metricKeySchema,
  numerator: z.number().nullable(),
  denominator: z.number().nullable(),
  value: z.number().nullable(),
  currency: z.string().nullable().default(null),
  maturity: dataMaturitySchema,
  /** Share of the underlying records with EXACT or HIGH_CONFIDENCE attribution. */
  attributionCoverage: z.number().min(0).max(1).nullable().default(null),
});
export type MetricValue = z.infer<typeof metricValueSchema>;

export function formatRateDe(r: Rate, fractionDigits = 1): string {
  if (r.value === null) return '–';
  return `${new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(r.value * 100)} %`;
}
