import { z } from 'zod';
import {
  type capiStageSchema,
  salesEventTypeSchema,
  syncStatusSchema,
  vqStatusSchema,
} from './enums';
import { uuidSchema } from './ids';
import { currencySchema, isoTimestampSchema } from './primitives';

/**
 * A canonical, provider-independent sales event. Written only on a *real* state
 * transition — a repeated HubSpot sync that observes the same stage produces no
 * event (spec §22, acceptance criterion 32).
 */
export const salesEventSchema = z.object({
  id: uuidSchema,
  type: salesEventTypeSchema,
  /** Business time of the transition, not the time we happened to sync it. */
  occurred_at: isoTimestampSchema,
  recorded_at: isoTimestampSchema,

  lead_id: uuidSchema.nullable().default(null),
  opportunity_id: uuidSchema.nullable().default(null),
  submission_id: uuidSchema.nullable().default(null),

  /** Which object the transition was observed on. */
  source_object: z.enum(['CONTACT', 'DEAL', 'INTERNAL', 'WEBHOOK']),
  hubspot_object_id: z.string().max(64).nullable().default(null),

  previous_state: z.string().max(120).nullable().default(null),
  new_state: z.string().max(120),

  mapping_version: z.number().int().min(1).nullable().default(null),
  /** Id of the webhook / sync record that produced this event — for replay. */
  source_event_id: z.string().max(128).nullable().default(null),
  attribution_snapshot_id: uuidSchema.nullable().default(null),

  /** Only present on REVENUE_RECOGNIZED / CLOSED_WON. */
  amount_minor: z.number().int().nullable().default(null),
  currency: currencySchema.nullable().default(null),
});
export type SalesEvent = z.infer<typeof salesEventSchema>;

/**
 * Reproducible VQ evaluation record (spec §22). Storing the model version and
 * reason codes is what makes a historical "qualified" decision auditable after
 * the qualification rules change.
 */
export const vqEvaluationSchema = z.object({
  vq_status: vqStatusSchema,
  vq_score: z.number().min(0).max(100).nullable().default(null),
  vq_reason_codes: z.array(z.string().max(64)).max(20).default([]),
  vq_model_version: z.string().max(40),
  vq_evaluated_at: isoTimestampSchema,
});
export type VqEvaluation = z.infer<typeof vqEvaluationSchema>;

export const SALES_EVENT_LABELS_DE: Readonly<
  Record<z.infer<typeof salesEventTypeSchema>, string>
> = {
  FORM_COMPLETED: 'Formular abgeschlossen',
  VQ_SCHEDULED: 'VQ terminiert',
  VQ_ATTENDED: 'VQ stattgefunden',
  VQ_NO_SHOW: 'VQ nicht wahrgenommen',
  VQ_PASSED: 'VQ qualifiziert',
  VQ_REJECTED: 'VQ abgelehnt',
  SALES_ACCEPTED: 'Vom Vertrieb angenommen',
  OPPORTUNITY_CREATED: 'Opportunity erstellt',
  CLOSED_WON: 'Gewonnen',
  CLOSED_LOST: 'Verloren',
  REVENUE_RECOGNIZED: 'Umsatz realisiert',
};

/**
 * Mapping of canonical sales events onto the four semantic CAPI stages
 * (spec §23). Events not listed here have no Meta counterpart and are only ever
 * used internally.
 */
export const SALES_EVENT_TO_CAPI_STAGE: Readonly<
  Partial<Record<z.infer<typeof salesEventTypeSchema>, z.infer<typeof capiStageSchema>>>
> = {
  FORM_COMPLETED: 'INITIAL_LEAD',
  VQ_SCHEDULED: 'MARKETING_QUALIFIED_LEAD',
  VQ_PASSED: 'SALES_OPPORTUNITY',
  OPPORTUNITY_CREATED: 'SALES_OPPORTUNITY',
  CLOSED_WON: 'CONVERTED',
};

/** CONVERTED is dispatched exactly once per opportunity (spec §23). */
export const ONCE_PER_OPPORTUNITY_STAGES: readonly z.infer<typeof capiStageSchema>[] = [
  'CONVERTED',
];

/* -------------------------------------------------------------------------- */
/* Lead + opportunity                                                          */
/* -------------------------------------------------------------------------- */

export const leadSchema = z.object({
  id: uuidSchema,
  /** Stable internal person identity, independent of CRM ids. */
  am_person_id: uuidSchema,
  submission_id: uuidSchema,
  created_at: isoTimestampSchema,
  hubspot_contact_id: z.string().max(64).nullable().default(null),
  hubspot_company_id: z.string().max(64).nullable().default(null),
  sync_status: syncStatusSchema.default('PENDING'),
  vq: vqEvaluationSchema.nullable().default(null),
});
export type Lead = z.infer<typeof leadSchema>;

/**
 * An opportunity is a commercial opportunity, not one per form submit. The
 * acquisition submission is bound once and never rewritten by later touches
 * (spec §22).
 */
export const opportunitySchema = z.object({
  id: uuidSchema,
  am_opportunity_id: uuidSchema,
  am_person_id: uuidSchema,
  /** Immutable: the submission that acquired this opportunity. */
  acquisition_submission_id: uuidSchema,
  acquisition_snapshot_id: uuidSchema,
  created_at: isoTimestampSchema,
  hubspot_deal_id: z.string().max(64).nullable().default(null),
  pipeline: z.string().max(120).nullable().default(null),
  stage: z.string().max(120).nullable().default(null),
  amount_minor: z.number().int().nullable().default(null),
  currency: currencySchema.nullable().default(null),
  closed_won_at: isoTimestampSchema.nullable().default(null),
  closed_lost_at: isoTimestampSchema.nullable().default(null),
  sync_status: syncStatusSchema.default('PENDING'),
});
export type Opportunity = z.infer<typeof opportunitySchema>;

export const revenueEventSchema = z.object({
  id: uuidSchema,
  opportunity_id: uuidSchema,
  occurred_at: isoTimestampSchema,
  amount_minor: z.number().int(),
  currency: currencySchema,
  kind: z.enum(['BOOKED', 'RECOGNIZED', 'ADJUSTMENT']),
  /** Set when a later value change contradicts an already-dispatched CONVERTED. */
  reconciliation_delta_minor: z.number().int().nullable().default(null),
});
export type RevenueEvent = z.infer<typeof revenueEventSchema>;
