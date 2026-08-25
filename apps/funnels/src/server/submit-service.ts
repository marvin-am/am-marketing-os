import { z } from 'zod';
import {
  consentRecordSchema,
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  mayUseForAdMeasurement,
  newId,
  outboxEventSchema,
  sha256Hex,
  uuidSchema,
  type AppEnvironment,
  type ConsentRecord,
  type DomainErrorCode,
  type FieldType,
  type OutboxEvent,
  type TrafficKind,
} from '@am/domain';
import {
  evaluateQualification,
  getField,
  normalizeAnswers,
  selectResultVariant,
  splitAnswers,
  validateSubmission,
  type Answers,
  type AnswerValue,
  type FieldValidationError,
  type MultiStepFormSpec,
  type QualificationOutcome,
} from '@am/funnel-schema';
import { buildAttributionSnapshot } from '@am/tracking';
import {
  buildInitialLeadEvent,
  type InitialLeadEventPair,
  type LeadIdentity,
  type PixelPayload,
} from '@am/meta';
import { logger } from '@am/observability';
import { assessSubmission, type SpamAssessment } from './spam';
import { resolveRedirect, type ResolvedRedirect } from './redirect';
import { getFunnelVersion, getPublishedFormSpec } from './published';
import type { FunnelStore, SubmissionDraft } from './ports';

/**
 * The final submit.
 *
 * This is the part that must not lose data, so the whole flow lives in one
 * dependency-injected function rather than inside a route handler: the route is
 * a thin shell that resolves identity and hands over, and every branch below —
 * tampering, spam, idempotency, a HubSpot outage — is reachable from a unit
 * test without a running server.
 *
 * Order of operations, and why:
 *
 * 1. **Spam first.** Honeypot, timing and origin are constant-time checks; a
 *    bot should not get to spend the validation budget.
 * 2. **Validation second, with the identical functions the client used.**
 *    `validateSubmission` walks the traversal the answers imply, so a
 *    hand-crafted POST cannot skip a step, invent an option or bypass consent.
 * 3. **Accept, attribution and outbox in one transaction.** The submission, its
 *    frozen attribution snapshot, the HubSpot sync row and the Meta CAPI row are
 *    written together. Nothing is dispatched inside the request.
 * 4. **CAPI only after acceptance**, sharing one `event_id` between the browser
 *    pixel and the server event so Meta deduplicates the pair.
 *
 * A HubSpot outage cannot fail this request, because HubSpot is never called
 * from it. The lead is accepted and the sync is queued.
 */

/* -------------------------------------------------------------------------- */
/* Wire format                                                                 */
/* -------------------------------------------------------------------------- */

const answerValueSchema: z.ZodType<AnswerValue> = z.union([
  z.string().max(8000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(200)).max(50),
  z.null(),
]);

export const submitRequestSchema = z.object({
  funnelVersionId: uuidSchema,
  formVersionId: uuidSchema,
  formInstanceId: uuidSchema,
  /** Client-generated idempotency key. Identical retries return one submission. */
  submissionAttemptId: uuidSchema,
  answers: z.record(z.string().min(1).max(64), answerValueSchema),
  /** Seconds between opening the form and submitting. */
  elapsedSeconds: z.number().nonnegative().max(86_400).nullable().optional(),
  stepsVisited: z.number().int().min(0).max(50).optional(),
});
export type SubmitRequest = z.infer<typeof submitRequestSchema>;

export interface SubmitContext {
  visitorId: string;
  sessionId: string;
  environment: AppEnvironment;
  trafficKind: TrafficKind;
  /** Result of the origin check performed by the route. */
  originOk: boolean;
  userAgent: string | null;
  /** Only ever forwarded to Meta with consent; never stored, never logged. */
  clientIpAddress: string | null;
  /** Absolute URL the submission was made from. */
  eventSourceUrl: string;
}

export interface SubmitDependencies {
  store: FunnelStore;
  now?: () => Date;
  generateId?: () => string;
  /** `META_PIXEL_ID`. `null` while Meta is not connected — never invented. */
  pixelId?: string | null;
  attributionWindowDays?: number;
  redirectAllowlist?: readonly string[];
  /**
   * Optional best-effort dispatch attempted *after* the transaction commits.
   * Its failure is swallowed: the outbox row is the durable record and the
   * worker retries it. Present so the outage path is testable.
   */
  dispatchHubspot?: (row: OutboxEvent) => Promise<void>;
}

export interface SubmitSuccessBody {
  ok: true;
  submissionId: string;
  /** True when this attempt id had already been accepted. */
  duplicate: boolean;
  outcome: QualificationOutcome;
  resultVariantId: string | null;
  redirect: ResolvedRedirect | null;
  /** `null` when no Meta pixel is configured or consent was not granted. */
  pixel: PixelPayload | null;
  /** Whether an initial-lead row was queued for the Conversions API. */
  capiQueued: boolean;
  /**
   * `false` while `META_PIXEL_ID` is unset. The row is still queued; the worker
   * completes it once the dataset arrives. Nothing is invented in the meantime.
   */
  capiConfigured: boolean;
}

export interface SubmitErrorBody {
  ok: false;
  code: DomainErrorCode;
  messageDe: string;
  fieldErrors?: FieldValidationError[];
  retryAfterSeconds?: number;
}

export type SubmitOutcome =
  | { status: 200; body: SubmitSuccessBody }
  | { status: number; body: SubmitErrorBody };

function failure(
  status: number,
  code: DomainErrorCode,
  messageDe: string,
  extra: Partial<SubmitErrorBody> = {},
): SubmitOutcome {
  return { status, body: { ok: false, code, messageDe, ...extra } };
}

export const RATE_LIMIT_MESSAGE_DE =
  'Zu viele Übermittlungen in kurzer Zeit. Bitte versuchen Sie es in Kürze erneut.';

/* -------------------------------------------------------------------------- */
/* CAPI / CRM helpers                                                          */
/* -------------------------------------------------------------------------- */

function firstAnswerOfType(
  spec: MultiStepFormSpec,
  answers: Answers,
  type: FieldType,
): string | null {
  for (const fieldId of Object.keys(spec.fields)) {
    const field = getField(spec, fieldId);
    if (!field || field.type !== type) continue;
    const value = answers[fieldId];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * The lead's identifiers, read out of the spec by field *type* rather than by a
 * hard-coded field id — a form author may rename `email` to `mail_adresse` and
 * the CAPI identity must not silently go empty.
 */
export function leadIdentityFrom(
  spec: MultiStepFormSpec,
  answers: Answers,
  extras: Pick<
    LeadIdentity,
    'externalId' | 'fbc' | 'fbp' | 'fbclid' | 'clientIpAddress' | 'clientUserAgent'
  >,
): LeadIdentity {
  return {
    email: firstAnswerOfType(spec, answers, 'EMAIL'),
    phone: firstAnswerOfType(spec, answers, 'PHONE'),
    firstName: firstAnswerOfType(spec, answers, 'FIRST_NAME'),
    lastName: firstAnswerOfType(spec, answers, 'LAST_NAME'),
    postalCode: firstAnswerOfType(spec, answers, 'POSTCODE'),
    country: 'de',
    ...extras,
  };
}

/**
 * Deterministic HubSpot dispatch id: a replay collapses onto one sync.
 *
 * Seeded from the submission *attempt*, for the same reason the Meta pair is —
 * the stored row id is minted by the database and differs on a retry that
 * resolves onto the original submission.
 */
export async function hubspotOutboxEventId(submissionAttemptId: string): Promise<string> {
  return sha256Hex(`hubspot:lead:${submissionAttemptId}`);
}

/**
 * The shared-event-id pair for the initial website lead. Returns `null` while
 * no Meta pixel is configured — a fabricated dataset id is worse than an
 * admitted gap (AGENTS.md rule 1).
 */
async function buildLeadPair(
  submissionAttemptId: string,
  pixelId: string | null,
  occurredAt: string,
  eventSourceUrl: string,
  identity: LeadIdentity,
  adMeasurement: boolean,
): Promise<InitialLeadEventPair | null> {
  if (!pixelId) return null;
  return buildInitialLeadEvent({
    submissionAttemptId,
    pixelId,
    occurredAt,
    eventSourceUrl,
    identity,
    consent: { adMeasurement },
    leadEventSource: 'A&M Funnel',
  });
}

/* -------------------------------------------------------------------------- */
/* The flow                                                                    */
/* -------------------------------------------------------------------------- */

export async function submitLead(
  rawBody: unknown,
  context: SubmitContext,
  deps: SubmitDependencies,
): Promise<SubmitOutcome> {
  const now = deps.now?.() ?? new Date();
  const generateId = deps.generateId ?? (() => newId());

  const parsed = submitRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return failure(400, 'VALIDATION_FAILED', 'Die Anfrage hat ein ungültiges Format.');
  }
  const request = parsed.data;

  const funnelVersion = await getFunnelVersion(request.funnelVersionId);
  const form = await getPublishedFormSpec(request.formVersionId);

  /* A published funnel version that actually serves this form version. Posting
     a foreign pair is a tampering attempt, not a 500. */
  if (!form || !funnelVersion || funnelVersion.state !== 'PUBLISHED') {
    return failure(
      404,
      'NOT_FOUND',
      'Dieses Formular ist nicht mehr verfügbar. Bitte laden Sie die Seite neu.',
    );
  }
  if (funnelVersion.formVersionId !== request.formVersionId) {
    return failure(
      400,
      'VALIDATION_FAILED',
      'Die Anfrage passt nicht zur veröffentlichten Version. Bitte laden Sie die Seite neu.',
    );
  }

  const spec = form.spec;

  /* ---- 1. spam and bot defence -------------------------------------- */
  const honeypotFieldId = spec.submit.honeypotFieldId;
  const honeypotValue = honeypotFieldId ? request.answers[honeypotFieldId] : undefined;

  const assessment: SpamAssessment = assessSubmission({
    honeypotValue,
    elapsedSeconds: request.elapsedSeconds ?? null,
    minCompletionSeconds: spec.submit.minCompletionSeconds,
    originOk: context.originOk,
    userAgent: context.userAgent,
    trafficKind: context.trafficKind,
    stepsVisited: request.stepsVisited,
  });

  if (assessment.rejected) {
    logger.warn('funnel.submit.rejected', {
      reason: 'SPAM',
      signals: assessment.signals,
      form_version_id: request.formVersionId,
      traffic_kind: context.trafficKind,
    });
    return failure(
      422,
      'SPAM_REJECTED',
      assessment.reasonDe ?? 'Die Übermittlung wurde als Spam eingestuft.',
    );
  }

  /* ---- 2. server-side validation, with the client's own functions ---- */
  const submitted: Answers = { ...request.answers };
  if (honeypotFieldId) delete submitted[honeypotFieldId];

  const answers = normalizeAnswers(spec, submitted);
  const validation = validateSubmission(spec, answers);
  if (!validation.ok) {
    logger.warn('funnel.submit.rejected', {
      reason: 'VALIDATION',
      form_version_id: request.formVersionId,
      field_ids: validation.errors.map((error) => error.fieldId),
      codes: validation.errors.map((error) => error.code),
    });
    return failure(
      422,
      'VALIDATION_FAILED',
      'Ihre Angaben sind unvollständig oder ungültig. Bitte prüfen Sie die markierten Felder.',
      { fieldErrors: validation.errors },
    );
  }

  /* ---- 3. deterministic qualification and result selection ----------- */
  const qualification = evaluateQualification(spec, answers);
  const variant = selectResultVariant(spec, answers, qualification);
  const split = splitAnswers(spec, answers);

  /* ---- 4. consent, attribution, outbox ------------------------------ */
  const submissionId = generateId();
  const occurredAt = now.toISOString();

  const consent: ConsentRecord = consentRecordSchema.parse({
    consent_version_id: spec.consent.consentVersionId,
    consent_version: 1,
    status: 'GRANTED',
    grantedPurposes: spec.consent.purposes,
    occurred_at: occurredAt,
    contextDe: `funnel:${request.funnelVersionId}`,
  });

  const touches = await deps.store.listTouches(context.visitorId);
  const attribution = buildAttributionSnapshot({
    submissionId,
    touches,
    windowDays: deps.attributionWindowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS,
    consent,
    now,
  });

  const adMeasurementAllowed = mayUseForAdMeasurement(consent);
  const pixelId = deps.pixelId ?? null;

  const identity = leadIdentityFrom(spec, answers, {
    externalId: context.visitorId,
    fbc: attribution.fbc,
    fbp: attribution.fbp,
    fbclid: attribution.fbclid,
    clientIpAddress: context.clientIpAddress,
    clientUserAgent: context.userAgent,
  });

  /* One event id for the browser pixel and the server event, derived from the
     submission attempt — the thing that exists exactly once per lead and is the
     same value before the write, after it, and on every retry. So a retry, a
     replay and the pixel all collapse onto the same Meta event. */
  const leadPair = await buildLeadPair(
    request.submissionAttemptId,
    pixelId,
    occurredAt,
    context.eventSourceUrl,
    identity,
    adMeasurementAllowed,
  );
  const leadEventId =
    leadPair?.eventId ?? (await sha256Hex(`lead:${request.submissionAttemptId}`));

  const hubspotEventId = await hubspotOutboxEventId(request.submissionAttemptId);
  const hubspotPayloadHash = await sha256Hex(
    JSON.stringify({
      submission_id: submissionId,
      form_version_id: spec.formVersionId,
      outcome: qualification.outcome,
      score: qualification.score,
    }),
  );
  const capiPayloadHash = await sha256Hex(
    JSON.stringify(
      leadPair?.server ?? {
        event_name: 'Lead',
        event_id: leadEventId,
        event_time: occurredAt,
        submission_id: submissionId,
      },
    ),
  );

  const outbox: OutboxEvent[] = [
    outboxEventSchema.parse({
      event_id: hubspotEventId,
      destination: 'HUBSPOT',
      event_name: 'lead.created',
      event_time: occurredAt,
      payload_hash: hubspotPayloadHash,
      status: 'PENDING',
      created_at: occurredAt,
      submission_id: submissionId,
      campaign_id: attribution.campaign_id,
    }),
    outboxEventSchema.parse({
      event_id: leadEventId,
      destination: 'META_CAPI',
      event_name: leadPair?.eventName ?? 'Lead',
      event_time: occurredAt,
      payload_hash: capiPayloadHash,
      status: 'PENDING',
      created_at: occurredAt,
      submission_id: submissionId,
      campaign_id: attribution.campaign_id,
      dataset_id: pixelId,
    }),
  ];

  const submission: SubmissionDraft = {
    submissionId,
    submissionAttemptId: request.submissionAttemptId,
    formInstanceId: request.formInstanceId,
    funnelId: funnelVersion.funnelId,
    funnelVersionId: funnelVersion.funnelVersionId,
    formId: spec.formId,
    formVersionId: spec.formVersionId,
    visitorId: context.visitorId,
    sessionId: context.sessionId,
    environment: context.environment,
    trafficKind: context.trafficKind,
    state: 'HUBSPOT_PENDING',
    qualification: {
      outcome: qualification.outcome,
      score: qualification.score,
      matchedRuleIds: qualification.matchedRuleIds,
      reasonCodes: qualification.reasonCodes,
    },
    resultVariantId: variant?.variantId ?? null,
    answersNonPii: split.nonPii,
    answersPii: split.pii,
    answersOperational: {
      ...split.operational,
      elapsed_seconds: request.elapsedSeconds ?? null,
      risk_score: assessment.score,
    },
    consent,
    riskScore: assessment.score,
    submittedAt: occurredAt,
  };

  /* ---- 5. one transaction: submission + snapshot + outbox rows ------- */
  const accepted = await deps.store.acceptSubmission({ submission, attribution, outbox });

  /* ---- 6. best-effort dispatch; an outage never fails the request ---- */
  if (accepted.created && deps.dispatchHubspot) {
    const row = outbox.find((entry) => entry.destination === 'HUBSPOT');
    if (row) {
      try {
        await deps.dispatchHubspot(row);
      } catch (error) {
        /* The outbox row is the durable record. Leaving it PENDING is exactly
           why it is written inside the transaction. */
        logger.warn('funnel.submit.hubspot_dispatch_failed', {
          submission_id: accepted.submissionId,
          outbox_event_id: row.event_id,
          retryable: true,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }

  /* ---- 7. the browser pixel, sharing the server event's id ----------- */
  /*
   * No rebuild. Both ids are seeded from the submission attempt, which is
   * settled before the write and identical for every retry of it, so the pixel
   * and the queued server event already carry the same id.
   *
   * They previously came from a locally generated submission id, and the store
   * returns the row id the database minted — so on the Postgres path the two
   * always differed, the rebuild always fired, and the queued CAPI row was left
   * holding the pre-transaction id. Nothing fails when that happens: Meta
   * simply stops recognising the pair and counts every lead twice.
   */
  const pixel: PixelPayload | null = adMeasurementAllowed ? (leadPair?.pixel ?? null) : null;

  const redirect =
    variant?.kind === 'REDIRECT'
      ? resolveRedirect(
          { target: variant.target, delaySeconds: variant.delaySeconds },
          deps.redirectAllowlist,
        )
      : resolveRedirect(spec.success.redirect, deps.redirectAllowlist);

  logger.info('funnel.submit.accepted', {
    submission_id: accepted.submissionId,
    duplicate: !accepted.created,
    outcome: qualification.outcome,
    outbox_events: accepted.outboxEventIds.length,
    capi_configured: pixelId !== null,
  });

  return {
    status: 200,
    body: {
      ok: true,
      submissionId: accepted.submissionId,
      duplicate: !accepted.created,
      outcome: qualification.outcome,
      resultVariantId: variant?.variantId ?? null,
      redirect,
      pixel,
      capiQueued: true,
      capiConfigured: pixelId !== null,
    },
  };
}
