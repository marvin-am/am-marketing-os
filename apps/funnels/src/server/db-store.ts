import {
  DomainError,
  type AppEnvironment,
  type FunnelKind,
  type OutboxEvent,
  type Touchpoint,
  type TrafficKind,
} from '@am/domain';
import {
  encryptJson,
  identityHash,
  sha256Hex,
  type AmDatabase,
  type FormInstanceRow,
  type FunnelVersionRow,
  type JsonObject,
  type NonPiiFieldType,
  type OutboxEventRow,
  type PublishedFunnelBundle,
  type SubmitLeadAnswer,
  type SubmitLeadPii,
  type TouchpointRow,
} from '@am/db';
import { getAppConfig } from '@am/config';
import {
  getField,
  type AnswerValue,
  type Answers,
  type FunnelSpec,
  type MultiStepFormSpec,
} from '@am/funnel-schema';
import { deterministicUuid } from '@am/tracking';
import { logger } from '@am/observability';
import type {
  CreateFormInstanceInput,
  FormInstanceRecord,
  FunnelExperimentRecord,
  FunnelStore,
  FunnelVersionRecord,
  SubmissionDraft,
} from './ports';

/**
 * `FunnelStore` over Postgres.
 *
 * The port speaks the runtime's language — a slug, a form instance, a touch, an
 * accepted submission. The schema speaks its own: a `published_funnels` row
 * binds a slug to exactly one funnel version, form version, consent version and
 * pixel, and every runtime write is derived from that binding rather than
 * trusted from the caller. This file is that translation and nothing else; the
 * routes, the pages and the components are unchanged.
 *
 * Three things are load bearing, because the port promises them and the routes
 * do not re-check them:
 *
 * 1. **A draft never serves.** `get_published_funnel` already filters on
 *    `is_live`, but the live binding and the version's own `state` are two
 *    different facts, so the version row is read and refused unless it is
 *    `PUBLISHED`.
 * 2. **`acceptSubmission` is one transaction.** `submit_lead_transactional`
 *    writes submission, answers, encrypted PII, status history, attribution
 *    snapshot and one outbox row in a single unit of work. See
 *    `queueRemainingOutbox` for the one row that does not fit in it and why.
 * 3. **`acceptSubmission` is idempotent on `submissionAttemptId`.** The unique
 *    index on `form_submissions.submission_attempt_id` decides the winner under
 *    real concurrency; every loser gets the winner's submission back.
 *
 * Nothing here writes a workspace id the caller supplied: every write derives it
 * from the published funnel the request already had to name.
 */

/* -------------------------------------------------------------------------- */
/* Caches                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How long a slug → published-binding mapping is trusted.
 *
 * A published *version* is immutable, so its spec is cached without expiry. The
 * binding is not: retiring a funnel flips `is_live`, and a funnel that keeps
 * accepting leads for an hour after it was pulled is a real cost. One minute
 * matches the slug TTL the render path already uses.
 */
export const BINDING_CACHE_TTL_MS = 60_000;

/**
 * Sessions this process has already bootstrapped. Bounded so a long-lived
 * instance cannot grow it without limit, and useful rather than merely fast:
 * `ensure_visitor_session` bumps `visitors.session_count` on every call, so
 * calling it once per session is the accurate behaviour, not just the cheap one.
 */
const SESSION_CACHE_LIMIT = 5_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/* -------------------------------------------------------------------------- */
/* The published binding                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything a runtime write needs that the port does not carry.
 *
 * `CreateFormInstanceInput` and `SubmissionDraft` name a funnel version; the
 * schema needs the workspace, the live binding and — for the visitor/session
 * bootstrap — the public slug. All three hang off `published_funnels`, which is
 * reachable from a funnel version id but not carried on it.
 */
interface PublishedBinding {
  publishedFunnelId: string;
  workspaceId: string;
  campaignId: string | null;
  slug: string;
  funnelId: string;
  /** The version the slug itself points at, before any experiment arm. */
  baseFunnelVersionId: string;
  formVersionId: string | null;
  consentVersionId: string | null;
  environment: AppEnvironment;
  experiment: FunnelExperimentRecord | null;
  /** Base version plus every arm's — the versions this binding may serve. */
  servedVersionIds: string[];
}

function bindingFrom(bundle: PublishedFunnelBundle): PublishedBinding {
  const experiment = experimentFrom(bundle);
  const served = new Set<string>([bundle.funnel_version_id]);
  for (const arm of experiment?.arms ?? []) served.add(arm.funnelVersionId);

  return {
    publishedFunnelId: bundle.published_funnel_id,
    workspaceId: bundle.workspace_id,
    campaignId: bundle.campaign_id,
    slug: bundle.public_slug,
    funnelId: bundle.funnel_id,
    baseFunnelVersionId: bundle.funnel_version_id,
    formVersionId: bundle.form_version_id,
    consentVersionId: bundle.consent?.consent_version_id ?? null,
    environment: bundle.environment,
    experiment,
    servedVersionIds: [...served],
  };
}

/**
 * The experiment as the runtime sees it.
 *
 * An arm with no `funnel_version_id` is an arm of a creative or form experiment:
 * it takes traffic but does not change which funnel version is served. It is
 * mapped onto the base version rather than dropped, because dropping it would
 * renormalise the allocations and silently re-bucket visitors who were meant to
 * see the unchanged funnel.
 */
function experimentFrom(bundle: PublishedFunnelBundle): FunnelExperimentRecord | null {
  const experiment = bundle.experiment;
  if (!experiment || experiment.arms.length === 0) return null;

  return {
    experimentId: experiment.experiment_id,
    state: experiment.state,
    assignmentSalt: experiment.assignment_salt,
    arms: experiment.arms.map((arm) => ({
      armId: arm.arm_id,
      allocation: arm.allocation,
      funnelVersionId: arm.funnel_version_id ?? bundle.funnel_version_id,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Row → port mapping                                                          */
/* -------------------------------------------------------------------------- */

const FUNNEL_KINDS: readonly FunnelKind[] = ['LANDING_PAGE', 'MULTI_STEP_FORM', 'HYBRID'];

/**
 * A stored spec, checked only for the discriminator the renderer switches on.
 *
 * A published spec was validated by `funnelSpecSchema` at publish time and is
 * immutable afterwards, so re-parsing a 60 kB document on the request an ad
 * click waits for buys nothing. A missing or unknown `kind` is a different
 * matter: it would reach the renderer as an unhandled branch, so it is refused
 * here and the slug reads as "not found" rather than as a 500.
 */
function asFunnelSpec(value: JsonObject, versionId: string): FunnelSpec | null {
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !FUNNEL_KINDS.includes(kind as FunnelKind)) {
    logger.error('funnel.store.spec_unusable', { funnel_version_id: versionId, kind: String(kind) });
    return null;
  }
  return value as unknown as FunnelSpec;
}

function asFormSpec(value: JsonObject, versionId: string): MultiStepFormSpec | null {
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== 'MULTI_STEP_FORM') {
    logger.error('funnel.store.form_spec_unusable', { form_version_id: versionId, kind: String(kind) });
    return null;
  }
  return value as unknown as MultiStepFormSpec;
}

function touchpointFrom(row: TouchpointRow): Touchpoint {
  return {
    id: row.id,
    visitor_id: row.visitor_id,
    session_id: row.session_id,
    occurred_at: row.occurred_at,
    channel: row.channel,
    role: row.role,
    confidence: row.confidence,
    from_signed_token: row.from_signed_token,
    campaign_id: row.campaign_id,
    campaign_version_id: row.campaign_version_id,
    angle_id: row.angle_id,
    angle_version_id: row.angle_version_id,
    offer_id: row.offer_id,
    offer_version_id: row.offer_version_id,
    creative_id: row.creative_id,
    creative_version_id: row.creative_version_id,
    funnel_id: row.funnel_id,
    funnel_version_id: row.funnel_version_id,
    form_id: row.form_id,
    form_version_id: row.form_version_id,
    experiment_id: row.experiment_id,
    experiment_arm_id: row.experiment_arm_id,
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    utm_content: row.utm_content,
    utm_term: row.utm_term,
    fbclid: row.fbclid,
    fbc: row.fbc,
    fbp: row.fbp,
    meta_campaign_id: row.meta_campaign_id,
    meta_adset_id: row.meta_adset_id,
    meta_ad_id: row.meta_ad_id,
    referrer: row.referrer,
    landing_url: row.landing_url,
  };
}

function outboxEventFrom(row: OutboxEventRow): OutboxEvent {
  return {
    event_id: row.event_id,
    destination: row.destination,
    event_name: row.event_name,
    event_time: row.event_time,
    payload_hash: row.payload_hash,
    status: row.status,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    provider_response_redacted: row.provider_response_redacted,
    sent_at: row.sent_at,
    created_at: row.created_at,
    campaign_id: row.campaign_id,
    submission_id: row.submission_id,
    opportunity_id: row.opportunity_id,
    /* `''` is the schema's "no dataset" — a nullable column would have made the
       dedup key permissive. The port speaks `null`. */
    dataset_id: row.dataset_id === '' ? null : row.dataset_id,
  };
}

function formInstanceFrom(row: FormInstanceRow): FormInstanceRecord {
  return {
    formInstanceId: row.id,
    visitorId: row.visitor_id,
    sessionId: row.session_id,
    funnelVersionId: row.funnel_version_id ?? '',
    formVersionId: row.form_version_id ?? '',
    experimentId: row.experiment_id,
    experimentArmId: row.experiment_arm_id,
    environment: row.environment,
    trafficKind: row.traffic_kind,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    lastStepId: row.current_step_key,
    submitted: row.completed_at !== null,
  };
}

/* -------------------------------------------------------------------------- */
/* Submission payload                                                          */
/* -------------------------------------------------------------------------- */

const NON_PII_FIELD_TYPES: readonly NonPiiFieldType[] = [
  'SINGLE_SELECT',
  'MULTI_SELECT',
  'BOOLEAN',
  'NUMBER',
  'RANGE',
  'SHORT_TEXT',
  'LONG_TEXT',
  'POSTCODE',
  'CONSENT',
];

/** Splits one answer across the four typed value columns. */
function answerValueColumns(value: AnswerValue): Pick<
  SubmitLeadAnswer,
  'value_text' | 'value_number' | 'value_bool' | 'value_options'
> {
  if (typeof value === 'string') return { value_text: value };
  if (typeof value === 'number') return { value_number: value };
  if (typeof value === 'boolean') return { value_bool: value };
  if (Array.isArray(value)) return { value_options: value };
  return {};
}

/**
 * The field type to store for an answer the spec does not declare.
 *
 * `answersOperational` carries values the runtime adds rather than the form —
 * `elapsed_seconds`, `risk_score`. They have no spec field, so their type is
 * read off the value. `submission_answers_non_pii` rejects a personal field type
 * with a CHECK constraint, which is what makes this fallback safe: the worst it
 * can do is mislabel a number, never smuggle an e-mail past the boundary.
 */
function inferredFieldType(value: AnswerValue): NonPiiFieldType {
  if (typeof value === 'number') return 'NUMBER';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (Array.isArray(value)) return 'MULTI_SELECT';
  return 'SHORT_TEXT';
}

function stepKeyOf(spec: MultiStepFormSpec | null, fieldId: string): string | null {
  if (!spec) return null;
  return spec.steps.find((step) => step.fieldIds.includes(fieldId))?.stepId ?? null;
}

/**
 * Builds the non-PII answer rows.
 *
 * Only `answersNonPii` and `answersOperational` are passed: `answersPii` goes to
 * `submission_pii_encrypted` as ciphertext and must never reach a queryable
 * column (AGENTS rule 7). A spec field whose declared type is personal is
 * dropped here as well — `splitAnswers` should never have put it in this bucket,
 * and failing closed costs one qualification answer where the alternative costs
 * a lead's e-mail address in a reporting table.
 */
function answerRows(
  spec: MultiStepFormSpec | null,
  submission: SubmissionDraft,
): SubmitLeadAnswer[] {
  const rows: SubmitLeadAnswer[] = [];

  const push = (
    fieldId: string,
    value: AnswerValue,
    piiClass: 'QUALIFICATION' | 'OPERATIONAL',
  ): void => {
    const field = spec ? getField(spec, fieldId) : null;
    const type = (field?.type ?? inferredFieldType(value)) as NonPiiFieldType;
    if (!NON_PII_FIELD_TYPES.includes(type)) {
      logger.warn('funnel.store.answer_dropped', { field_id: fieldId, reason: 'PII_FIELD_TYPE' });
      return;
    }
    rows.push({
      field_key: fieldId,
      step_key: stepKeyOf(spec, fieldId),
      field_type: type,
      pii_class: piiClass,
      qualification_class: field?.qualificationClass ?? 'NONE',
      /* Per-field score contributions are not part of the qualification result
         the port carries — `evaluateQualification` reports matched rules, not a
         per-answer breakdown — so the column stays null rather than carrying a
         number nobody computed. */
      score_contribution: null,
      ...answerValueColumns(value),
    });
  };

  for (const [fieldId, value] of Object.entries(submission.answersNonPii)) {
    push(fieldId, value, 'QUALIFICATION');
  }
  for (const [fieldId, value] of Object.entries(submission.answersOperational)) {
    push(fieldId, value, 'OPERATIONAL');
  }
  return rows;
}

function firstAnswerOfType(
  spec: MultiStepFormSpec | null,
  answers: Answers,
  type: 'EMAIL' | 'PHONE',
): string | null {
  if (!spec) return null;
  for (const [fieldId, value] of Object.entries(answers)) {
    if (getField(spec, fieldId)?.type !== type) continue;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * The encrypted PII record.
 *
 * The ciphertext is not bound to the submission with AAD, deliberately: the
 * submission id is minted by `submit_lead_transactional` and does not exist yet
 * at this point, so binding it would mean binding the wrong id. See the store's
 * `acceptSubmission` for the same constraint seen from the outbox side.
 */
function piiRecord(spec: MultiStepFormSpec | null, submission: SubmissionDraft): SubmitLeadPii | null {
  const answers = submission.answersPii;
  if (Object.keys(answers).length === 0) return null;

  const envelope = encryptJson(answers);
  const email = firstAnswerOfType(spec, answers, 'EMAIL');
  const phone = firstAnswerOfType(spec, answers, 'PHONE');
  const at = email?.lastIndexOf('@') ?? -1;

  return {
    key_version: envelope.key_version,
    iv: envelope.iv,
    auth_tag: envelope.auth_tag,
    ciphertext: envelope.ciphertext,
    email_hash: email ? identityHash(email) : null,
    phone_hash: phone ? identityHash(phone) : null,
    email_domain: email && at > 0 ? email.slice(at + 1).toLowerCase() : null,
  };
}

/** Stable hash over the whole answer set, so a re-post is detectable. */
function answersHash(submission: SubmissionDraft): string {
  const merged: Answers = {
    ...submission.answersNonPii,
    ...submission.answersOperational,
    ...submission.answersPii,
  };
  const canonical = Object.keys(merged)
    .sort()
    .map((key) => `${key}=${JSON.stringify(merged[key] ?? null)}`)
    .join('\n');
  return sha256Hex(canonical);
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface DatabaseFunnelStore extends FunnelStore {
  readonly mode: 'supabase';
}

function missingRead(method: string): DomainError {
  return new DomainError('PROVIDER_NOT_CONFIGURED', {
    messageDe:
      'Die verbundene Datenbank stellt eine vom Funnel-Runtime benötigte Leseoperation nicht bereit.',
    details: { method },
  });
}

function notPublished(funnelVersionId: string): DomainError {
  return new DomainError('NOT_FOUND', {
    messageDe:
      'Dieser Funnel ist nicht live geschaltet. Übermittlungen nimmt nur eine veröffentlichte Version an.',
    details: { funnelVersionId },
  });
}

export function createDatabaseStore(db: AmDatabase): DatabaseFunnelStore {
  const bindingsBySlug = new Map<string, CacheEntry<PublishedBinding>>();
  const bindingsByVersion = new Map<string, CacheEntry<PublishedBinding>>();
  /* Published form versions are immutable, so their specs are cached without a
     TTL — the same reason `published.ts` caches published funnel versions. */
  const formSpecs = new Map<string, MultiStepFormSpec | null>();
  const bootstrappedSessions = new Set<string>();

  function cacheBinding(binding: PublishedBinding, now: number): PublishedBinding {
    const entry: CacheEntry<PublishedBinding> = { value: binding, expiresAt: now + BINDING_CACHE_TTL_MS };
    bindingsBySlug.set(binding.slug, entry);
    for (const versionId of binding.servedVersionIds) bindingsByVersion.set(versionId, entry);
    return binding;
  }

  function cached(map: Map<string, CacheEntry<PublishedBinding>>, key: string): PublishedBinding | null {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      map.delete(key);
      return null;
    }
    return entry.value;
  }

  async function bindingBySlug(slug: string): Promise<PublishedBinding | null> {
    const hit = cached(bindingsBySlug, slug);
    if (hit) return hit;

    const bundle = await db.funnels.getPublishedBySlug(slug);
    if (!bundle) return null;
    return cacheBinding(bindingFrom(bundle), Date.now());
  }

  /**
   * The live binding a funnel version is served under, or `null`.
   *
   * The runtime is handed a version id — by the submit request, by the
   * collector, by an experiment arm — and every write needs the binding behind
   * it. There is no index from a version to its published funnel, so the walk
   * goes through the version's campaign: its live bindings are few, and the
   * result is cached under every version the binding serves, so an arm's version
   * costs the walk once per minute rather than once per request.
   */
  async function bindingForVersion(
    funnelVersionId: string,
    version?: FunnelVersionRow | null,
  ): Promise<PublishedBinding | null> {
    const hit = cached(bindingsByVersion, funnelVersionId);
    if (hit) return hit;

    const row = version ?? (await db.funnels.getFunnelVersion(funnelVersionId));
    if (!row) return null;

    const published = (await db.funnels.listPublished(row.campaign_id)).filter(
      (candidate) => candidate.is_live && candidate.unpublished_at === null,
    );

    const direct = published.find((candidate) => candidate.funnel_version_id === funnelVersionId);
    if (direct) {
      const binding = await bindingBySlug(direct.public_slug);
      if (binding) return binding;
    }

    /* Not the version the slug points at — so either an experiment arm's, or a
       version that is simply not live. Only a binding that runs an experiment
       can be the former, which keeps this to one extra read in the rare case. */
    for (const candidate of published) {
      if (candidate.experiment_id === null || candidate.funnel_id !== row.funnel_id) continue;
      const binding = await bindingBySlug(candidate.public_slug);
      if (binding?.servedVersionIds.includes(funnelVersionId)) return binding;
    }

    return null;
  }

  async function formSpecFor(formVersionId: string): Promise<MultiStepFormSpec | null> {
    const hit = formSpecs.get(formVersionId);
    if (hit !== undefined) return hit;

    const row = await db.funnels.getFormVersion(formVersionId);
    const spec = row ? asFormSpec(row.spec, formVersionId) : null;
    formSpecs.set(formVersionId, spec);
    return spec;
  }

  function toVersionRecord(
    row: FunnelVersionRow,
    binding: PublishedBinding | null,
  ): FunnelVersionRecord | null {
    const spec = asFunnelSpec(row.spec, row.id);
    if (!spec) return null;

    return {
      funnelId: row.funnel_id,
      funnelVersionId: row.id,
      /* The public slug lives on the live binding, not on the version. A draft
         reached by id in preview has none; its spec may still declare one. */
      slug: binding?.slug ?? ('slug' in spec ? spec.slug : ''),
      kind: spec.kind,
      state: row.state,
      publishedAt: row.published_at,
      spec,
      formVersionId: row.form_version_id ?? binding?.formVersionId ?? null,
      /* Only the version the arm actually serves is part of the experiment the
         runtime applies; the binding already resolved that. */
      experiment: binding?.experiment ?? null,
    };
  }

  /**
   * Opens the visitor and the session the write is about to reference.
   *
   * `form_instances`, `touchpoints` and `form_submissions` all carry foreign
   * keys onto `visitors` and `sessions`, and `submit_lead_transactional`
   * additionally refuses a submission whose session it does not know — which is
   * what stops a direct RPC call from manufacturing a lead with no funnel visit
   * behind it. The RPC derives the workspace from the slug, so no caller ever
   * supplies one.
   */
  async function ensureSession(
    binding: PublishedBinding,
    visitorId: string,
    sessionId: string,
    environment: AppEnvironment,
    trafficKind: TrafficKind,
    marketing: Partial<Touchpoint> = {},
  ): Promise<void> {
    if (bootstrappedSessions.has(sessionId)) return;

    await db.tracking.ensureVisitorSession({
      public_slug: binding.slug,
      visitor_id: visitorId,
      session_id: sessionId,
      environment,
      traffic_kind: trafficKind,
      channel: marketing.channel,
      landing_url: marketing.landing_url ?? null,
      referrer: marketing.referrer ?? null,
      utm_source: marketing.utm_source ?? null,
      utm_medium: marketing.utm_medium ?? null,
      utm_campaign: marketing.utm_campaign ?? null,
      utm_content: marketing.utm_content ?? null,
      utm_term: marketing.utm_term ?? null,
      fbclid: marketing.fbclid ?? null,
      fbc: marketing.fbc ?? null,
      fbp: marketing.fbp ?? null,
      meta_campaign_id: marketing.meta_campaign_id ?? null,
      meta_adset_id: marketing.meta_adset_id ?? null,
      meta_ad_id: marketing.meta_ad_id ?? null,
    });

    if (bootstrappedSessions.size >= SESSION_CACHE_LIMIT) bootstrappedSessions.clear();
    bootstrappedSessions.add(sessionId);
  }

  function getFormInstance(id: string): Promise<FormInstanceRow | null> {
    if (!db.tracking.getFormInstance) throw missingRead('tracking.getFormInstance');
    return db.tracking.getFormInstance(id);
  }

  function findFormInstance(
    visitorId: string,
    sessionId: string,
    formVersionId: string,
  ): Promise<FormInstanceRow | null> {
    if (!db.tracking.findFormInstance) throw missingRead('tracking.findFormInstance');
    return db.tracking.findFormInstance(visitorId, sessionId, formVersionId);
  }

  function listOutbox(submissionId: string): Promise<OutboxEventRow[]> {
    if (!db.outbox.listBySubmission) throw missingRead('outbox.listBySubmission');
    return db.outbox.listBySubmission(submissionId);
  }

  /**
   * The outbox rows that did not fit in the transaction.
   *
   * `submit_lead_transactional` takes exactly one outbox row, and the funnel
   * runtime queues two: the HubSpot lead sync and the Meta CAPI initial lead.
   * The HubSpot row is the one that goes into the transaction — it is the lead
   * itself, and "a HubSpot outage never loses a lead" is the guarantee that
   * needs the transaction. The remainder is queued immediately afterwards.
   *
   * Only on the creating call: the runtime derives its dispatch ids from a
   * per-attempt submission id, so re-queueing on a duplicate attempt would add a
   * second Meta event for the same lead rather than deduplicate onto the first.
   * A failure here is logged and swallowed — the lead is already committed, and
   * failing the request would tell the visitor their enquiry was lost when it
   * was not.
   */
  async function queueRemainingOutbox(
    binding: PublishedBinding,
    submissionId: string,
    rows: readonly OutboxEvent[],
  ): Promise<void> {
    for (const row of rows) {
      try {
        await db.outbox.enqueue({
          workspace_id: binding.workspaceId,
          destination: row.destination,
          event_id: row.event_id,
          dataset_id: row.dataset_id ?? '',
          event_name: row.event_name,
          event_time: row.event_time,
          payload: {},
          payload_hash: row.payload_hash,
          campaign_id: row.campaign_id,
          submission_id: submissionId,
        });
      } catch (error) {
        logger.error('funnel.store.outbox_queue_failed', {
          submission_id: submissionId,
          destination: row.destination,
          outbox_event_id: row.event_id,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }

  return {
    mode: 'supabase',

    async loadPublishedFunnelBySlug(slug) {
      const binding = await bindingBySlug(slug);
      if (!binding) return null;

      const row = await db.funnels.getFunnelVersion(binding.baseFunnelVersionId);
      /* `is_live` and the version's own state are two different facts. A binding
         that points at a draft is a misconfiguration, not a licence to serve it
         (AGENTS.md rule 6). */
      if (!row || row.state !== 'PUBLISHED') return null;
      return toVersionRecord(row, binding);
    },

    async loadFunnelVersion(funnelVersionId) {
      const row = await db.funnels.getFunnelVersion(funnelVersionId);
      if (!row) return null;
      return toVersionRecord(row, await bindingForVersion(funnelVersionId, row));
    },

    async loadPublishedFormSpec(formVersionId) {
      const row = await db.funnels.getFormVersion(formVersionId);
      if (!row || row.state !== 'PUBLISHED') return null;
      const spec = await formSpecFor(formVersionId);
      if (!spec) return null;

      return {
        formId: row.form_definition_id,
        formVersionId: row.id,
        state: row.state,
        publishedAt: row.published_at,
        spec,
      };
    },

    async createFormInstance(input) {
      if (input.touch) await this.recordTouch(input.touch);

      const binding = await bindingForVersion(input.funnelVersionId);
      if (!binding) {
        /*
         * A version with no live binding is a draft in preview. It has no
         * published funnel to derive a workspace from and no slug to open a
         * session against, so there is nothing to write — the reviewer gets the
         * page, the id is derived rather than stored, and no metric is polluted
         * by a version nobody was shown. The same shape the bot path uses.
         */
        return derivedInstance(input);
      }

      const existing = await findFormInstance(input.visitorId, input.sessionId, input.formVersionId);
      if (existing) {
        const refreshed = await db.tracking.updateFormInstance(existing.id, {
          last_activity_at: laterOf(existing.last_activity_at, input.startedAt),
        });
        return formInstanceFrom(refreshed);
      }

      await ensureSession(
        binding,
        input.visitorId,
        input.sessionId,
        input.environment,
        input.trafficKind,
      );

      const spec = await formSpecFor(input.formVersionId);
      const row = await db.tracking.createFormInstance({
        workspace_id: binding.workspaceId,
        published_funnel_id: binding.publishedFunnelId,
        funnel_version_id: input.funnelVersionId,
        form_version_id: input.formVersionId,
        visitor_id: input.visitorId,
        session_id: input.sessionId,
        campaign_id: binding.campaignId,
        experiment_id: input.experimentId,
        experiment_arm_id: input.experimentArmId,
        started_at: input.startedAt,
        last_activity_at: input.startedAt,
        completed_at: null,
        abandoned_at: null,
        current_step_key: null,
        steps_completed: 0,
        step_count: spec?.steps.length ?? 0,
        environment: input.environment,
        traffic_kind: input.trafficKind,
      });
      return formInstanceFrom(row);
    },

    async recordStepProgress(input) {
      const instance = await getFormInstance(input.formInstanceId);
      /* A derived id — a crawl, or a preview of a draft — has no row behind it.
         Nothing was stored for it on purpose, so nothing is updated for it. */
      if (!instance) return;

      const spec = instance.form_version_id ? await formSpecFor(instance.form_version_id) : null;
      const stepIndex = spec?.steps.findIndex((step) => step.stepId === input.stepId) ?? -1;

      /*
       * `steps_completed` is set to how far the visitor has got, not incremented
       * per event. A beacon is retried, replayed and delivered out of order, and
       * an increment would count the same step twice — which is exactly the
       * doubled step metric a forked form instance produces, arrived at from the
       * other direction.
       */
      const reached =
        stepIndex >= 0 ? stepIndex + (input.completed ? 1 : 0) : instance.steps_completed;

      await db.tracking.updateFormInstance(instance.id, {
        current_step_key: input.stepId,
        steps_completed: Math.max(instance.steps_completed, reached),
        step_count: spec ? spec.steps.length : instance.step_count,
        last_activity_at: laterOf(instance.last_activity_at, input.occurredAt),
      });
    },

    async recordTouch(touch) {
      const binding = await bindingForTouch(touch);

      if (binding) {
        await ensureSession(
          binding,
          touch.visitor_id,
          touch.session_id,
          getAppConfig().environment,
          trafficKindForTouch(touch),
          touch,
        );
        await appendTouch(touch, binding.workspaceId);
        return;
      }

      /* No live funnel behind this touch. It can still be recorded if the
         visitor is already known — a return visit through a retired slug — and
         is otherwise dropped rather than attributed to a guessed workspace. */
      const visitor = await db.tracking.getVisitor(touch.visitor_id);
      const session = visitor ? await db.tracking.getSession(touch.session_id) : null;
      if (!visitor || !session) {
        logger.warn('funnel.store.touch_dropped', {
          reason: 'NO_PUBLISHED_FUNNEL',
          funnel_version_id: touch.funnel_version_id,
        });
        return;
      }
      await appendTouch(touch, visitor.workspace_id);
    },

    async listTouches(visitorId) {
      const rows = await db.attribution.listTouchpoints(visitorId);
      return rows.map(touchpointFrom);
    },

    async acceptSubmission(input) {
      const { submission, attribution, outbox } = input;

      const binding = await bindingForVersion(submission.funnelVersionId);
      if (!binding) throw notPublished(submission.funnelVersionId);

      await ensureSession(
        binding,
        submission.visitorId,
        submission.sessionId,
        submission.environment,
        submission.trafficKind,
      );

      const spec = await formSpecFor(submission.formVersionId);
      /* A form instance id the runtime derived rather than stored (a crawl, a
         preview) references no row, and the column is a foreign key. Nulling it
         keeps the lead; passing it would lose the lead to a constraint. */
      const instance = await getFormInstance(submission.formInstanceId);

      /* The HubSpot row rides inside the transaction; see queueRemainingOutbox. */
      const primary = outbox.find((row) => row.destination === 'HUBSPOT') ?? outbox[0] ?? null;
      const rest = outbox.filter((row) => row !== primary);

      const result = await db.submissions.submitLead({
        submission_attempt_id: submission.submissionAttemptId,
        published_funnel_id: binding.publishedFunnelId,
        form_instance_id: instance?.id ?? null,
        form_version_id: submission.formVersionId,
        visitor_id: submission.visitorId,
        session_id: submission.sessionId,
        experiment_id: instance?.experiment_id ?? null,
        experiment_arm_id: instance?.experiment_arm_id ?? null,
        state: submission.state,
        submitted_at: submission.submittedAt,
        consent_version_id: submission.consent.consent_version_id,
        consent_status: submission.consent.status,
        consent_purposes: submission.consent.grantedPurposes,
        /* The exact German text the visitor agreed to, hashed. A pointer to
           whatever the text says today would not be evidence of consent. */
        consent_text_hash: spec ? sha256Hex(spec.consent.textDe) : null,
        /* The port scores 0…100; the column is a rate with a 0…1 CHECK. */
        spam_score: submission.riskScore / 100,
        validation_error_codes: [],
        answers_hash: answersHash(submission),
        actor_label: 'funnel-runtime',
        correlation_id: submission.submissionAttemptId,
        answers: answerRows(spec, submission),
        pii: piiRecord(spec, submission),
        attribution: attribution as unknown as Record<string, unknown>,
        outbox: primary
          ? {
              destination: primary.destination,
              event_id: primary.event_id,
              dataset_id: primary.dataset_id ?? '',
              event_name: primary.event_name,
              event_time: primary.event_time,
              payload: {},
              payload_hash: primary.payload_hash,
            }
          : null,
      });

      if (result.created && rest.length > 0) {
        await queueRemainingOutbox(binding, result.submission_id, rest);
      }

      /* Read back rather than echo: the answer to "what is queued for this lead"
         is the queue's, and on a duplicate attempt the rows that exist are the
         first attempt's, not this one's. */
      const queued = await listOutbox(result.submission_id);
      return {
        submissionId: result.submission_id,
        created: result.created,
        outboxEventIds: queued.map((row) => row.event_id),
      };
    },

    async recordEvents(events) {
      if (events.length === 0) return 0;
      return db.tracking.recordEvents(events as unknown as Record<string, unknown>[]);
    },

    async listOutboxForSubmission(submissionId) {
      const rows = await listOutbox(submissionId);
      return rows.map(outboxEventFrom);
    },
  };

  /* ---- helpers that need the closure ---------------------------------- */

  async function appendTouch(touch: Touchpoint, workspaceId: string): Promise<void> {
    try {
      await db.attribution.appendTouchpoint({
        id: touch.id,
        workspace_id: workspaceId,
        visitor_id: touch.visitor_id,
        session_id: touch.session_id,
        occurred_at: touch.occurred_at,
        channel: touch.channel,
        role: touch.role,
        confidence: touch.confidence,
        from_signed_token: touch.from_signed_token,
        campaign_id: touch.campaign_id,
        campaign_version_id: touch.campaign_version_id,
        angle_id: touch.angle_id,
        angle_version_id: touch.angle_version_id,
        offer_id: touch.offer_id,
        offer_version_id: touch.offer_version_id,
        creative_id: touch.creative_id,
        creative_version_id: touch.creative_version_id,
        funnel_id: touch.funnel_id,
        funnel_version_id: touch.funnel_version_id,
        form_id: touch.form_id,
        form_version_id: touch.form_version_id,
        experiment_id: touch.experiment_id,
        experiment_arm_id: touch.experiment_arm_id,
        utm_source: touch.utm_source,
        utm_medium: touch.utm_medium,
        utm_campaign: touch.utm_campaign,
        utm_content: touch.utm_content,
        utm_term: touch.utm_term,
        fbclid: touch.fbclid,
        fbc: touch.fbc,
        fbp: touch.fbp,
        meta_campaign_id: touch.meta_campaign_id,
        meta_adset_id: touch.meta_adset_id,
        meta_ad_id: touch.meta_ad_id,
        referrer: touch.referrer,
        landing_url: touch.landing_url,
      });
    } catch (error) {
      /* The touch id is deterministic in the visitor, the session and the
         landing URL, so a server component that renders twice produces the same
         touch. The primary key collapsing that into one row is the append being
         idempotent, not a failure. */
      if (isUniqueViolation(error)) return;
      throw error;
    }
  }

  async function bindingForTouch(touch: Touchpoint): Promise<PublishedBinding | null> {
    if (touch.funnel_version_id) {
      const byVersion = await bindingForVersion(touch.funnel_version_id);
      if (byVersion) return byVersion;
    }
    const slug = slugFromLandingUrl(touch.landing_url);
    return slug ? bindingBySlug(slug) : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Free helpers                                                                */
/* -------------------------------------------------------------------------- */

/** ISO timestamps only ever move forward; an out-of-order beacon must not rewind. */
function laterOf(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof DomainError)) return false;
  return (error.details as { pgCode?: unknown } | undefined)?.pgCode === '23505';
}

/**
 * The public slug a touch happened on.
 *
 * `recordTouch` receives a touch and nothing else, and the schema needs a live
 * funnel to derive a workspace from. The landing URL is the funnel the visitor
 * actually landed on, and `/f/<slug>` is the only public shape the runtime
 * serves, so it is read from there when a signed token did not already name the
 * version.
 */
export function slugFromLandingUrl(landingUrl: string | null): string | null {
  if (!landingUrl) return null;
  try {
    const segments = new URL(landingUrl).pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments[0] !== 'f') return null;
    return decodeURIComponent(segments[1] ?? '') || null;
  } catch {
    return null;
  }
}

/**
 * How a touch's session is classified.
 *
 * The full classification lives in `classifyTraffic`, which reads cookies, the
 * user agent and the host — none of which a `Touchpoint` carries. The preview
 * path is recoverable from the landing URL and is the one that matters most,
 * because preview traffic must never reach production metrics. Internal and
 * test traffic whose very first write is a touch is therefore recorded as
 * PRODUCTION; closing that needs the classification on the touch itself.
 */
function trafficKindForTouch(touch: Touchpoint): TrafficKind {
  if (!touch.landing_url) return 'PRODUCTION';
  try {
    return new URL(touch.landing_url).pathname.startsWith('/preview/') ? 'PREVIEW' : 'PRODUCTION';
  } catch {
    return 'PRODUCTION';
  }
}

/**
 * A form instance for a render that must not write one.
 *
 * The id is derived from the visitor and the form version, so the page's
 * beacons carry a stable id and the client code is unchanged, while nothing is
 * stored and no step metric is diluted. Same derivation the bot path in
 * `render.ts` uses, for the same reason.
 */
function derivedInstance(input: CreateFormInstanceInput): FormInstanceRecord {
  return {
    formInstanceId: deterministicUuid(
      'unstored-form-instance',
      `${input.visitorId}:${input.formVersionId}`,
    ),
    visitorId: input.visitorId,
    sessionId: input.sessionId,
    funnelVersionId: input.funnelVersionId,
    formVersionId: input.formVersionId,
    experimentId: input.experimentId,
    experimentArmId: input.experimentArmId,
    environment: input.environment,
    trafficKind: input.trafficKind,
    startedAt: input.startedAt,
    lastActivityAt: input.startedAt,
    lastStepId: null,
    submitted: false,
  };
}
