'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Loader2, WifiOff } from 'lucide-react';
import {
  computeProgress,
  entryStepId,
  getStep,
  nextTarget,
  stepOfField,
  validateStep,
  visibleFields,
  type Answers,
  type AnswerValue,
  type FieldValidationError,
  type MultiStepFormSpec,
  type ResultVariant,
} from '@am/funnel-schema';
import type { TrackerContext } from '@am/tracking/beacon';
import { FormFieldControl } from './form-field';
import { StepProgress } from './progress';
import { ResultView } from './result-view';
import { clearDraft, loadDraft, saveDraft } from '@/lib/answers-storage';
import { fieldDomId } from '@/lib/dom-ids';
import { firePixelLead } from '@/lib/pixel';
import { randomId } from '@/lib/random-id';
import { useTracker } from '@/lib/use-tracker';
import type { SubmitErrorBody, SubmitSuccessBody } from '@/server/submit-service';
import type { FormTargets } from '@/server/spec-targets';

/**
 * The multi-step form runtime.
 *
 * Branching, validation and progress are **not** implemented here: every one of
 * them calls `@am/funnel-schema`, the same functions the submit handler runs on
 * the server. That is the whole point of the package — a branch that behaves
 * differently in the browser than in the API is impossible by construction, and
 * a client-side rule the server does not share is a rule a tampered POST walks
 * straight past.
 *
 * Mobile-first behaviour that is load-bearing rather than decorative:
 *
 * - one decision per screen, and contact data only on the final business step;
 * - answers survive going back (React state) and a reload (session storage,
 *   **non-PII only** — see `answers-storage.ts`);
 * - focus moves to the first invalid field, with the German message from
 *   `VALIDATION_MESSAGES_DE` announced through `role="alert"`;
 * - progress uses `computeProgress`'s indeterminate mode on a branched path;
 * - loading, offline, error and retry are real states, not a spinner that never
 *   resolves. A retry reuses the same `submission_attempt_id`, so pressing the
 *   button twice cannot create two leads.
 */

export interface FunnelFormProps {
  spec: MultiStepFormSpec;
  funnelVersionId: string;
  formInstanceId: string;
  targets: FormTargets;
  trackerContext: TrackerContext;
  experiment: { experimentId: string; armId: string } | null;
  submitEndpoint: string;
  collectEndpoint: string;
  /** Skip the intro screen — the hybrid page has already made the offer. */
  skipIntro?: boolean;
  /** Emit `funnel_viewed` from here; the page has no other client component. */
  emitEntryEvents?: boolean;
}

type Phase = 'INTRO' | 'STEP' | 'SUBMITTING' | 'RESULT';

const OFFLINE_MESSAGE_DE =
  'Sie sind offline. Ihre Antworten bleiben erhalten — bitte senden Sie erneut, sobald die Verbindung steht.';

const PRIMARY_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--am-radius)] bg-brand px-4 py-2 text-base font-semibold text-brand-foreground disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--am-ring)]';

const SECONDARY_BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--am-radius)] border border-border bg-surface px-4 py-2 text-base font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--am-ring)]';

function byFieldId(errors: readonly FieldValidationError[]): Record<string, FieldValidationError> {
  const map: Record<string, FieldValidationError> = {};
  for (const error of errors) map[error.fieldId] = error;
  return map;
}

/**
 * A hidden field no human can reach: off-screen, removed from the accessibility
 * tree and skipped by the tab order. `display: none` is deliberately avoided —
 * the crude bots this catches skip fields that are not rendered at all.
 */
function Honeypot({
  fieldId,
  value,
  onChange,
}: {
  fieldId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      aria-hidden="true"
      style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden' }}
    >
      <label htmlFor={`hp-${fieldId}`}>Bitte nicht ausfüllen</label>
      <input
        id={`hp-${fieldId}`}
        name={fieldId}
        type="text"
        tabIndex={-1}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function FunnelForm({
  spec,
  funnelVersionId,
  formInstanceId,
  targets,
  trackerContext,
  experiment,
  submitEndpoint,
  collectEndpoint,
  skipIntro = false,
  emitEntryEvents = true,
}: FunnelFormProps) {
  const firstStepId = entryStepId(spec) ?? '';

  const [phase, setPhase] = useState<Phase>(skipIntro ? 'STEP' : 'INTRO');
  const [answers, setAnswers] = useState<Answers>({});
  const [stepId, setStepId] = useState<string>(firstStepId);
  const [history, setHistory] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, FieldValidationError>>({});
  const [terminalVariantId, setTerminalVariantId] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitSuccessBody | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ fieldId: string; tick: number } | null>(null);

  const attemptIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number>(Date.now());
  const entryEventsSentRef = useRef(false);
  const restoredRef = useRef(false);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const honeypotRef = useRef('');
  const [honeypot, setHoneypot] = useState('');

  const tracker = useTracker(collectEndpoint, {
    ...trackerContext,
    form_instance_id: formInstanceId,
  });

  /* ---- entry events, exactly once per actual render ------------------ */
  useEffect(() => {
    if (!emitEntryEvents || entryEventsSentRef.current) return;
    entryEventsSentRef.current = true;
    tracker.funnelViewed();
    tracker.formViewed();
    if (experiment) {
      /* Fired here, on a render that happened — never at assignment time. A
         visitor bucketed into an arm they never saw would dilute that arm. */
      tracker.experimentExposed({
        experiment_id: experiment.experimentId,
        experiment_arm_id: experiment.armId,
      });
    }
  }, [emitEntryEvents, experiment, tracker]);

  /* ---- restore a draft after hydration ------------------------------- */
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const draft = loadDraft(spec);
    if (!draft) return;
    if (Object.keys(draft.answers).length === 0) return;
    setAnswers(draft.answers);
    setHistory(draft.stepHistory);
    startedAtRef.current = draft.startedAtMs;
    if (draft.currentStepId && getStep(spec, draft.currentStepId)) {
      setStepId(draft.currentStepId);
      setPhase('STEP');
    }
  }, [spec]);

  /* ---- persist the draft (non-PII only) ------------------------------ */
  useEffect(() => {
    if (phase === 'RESULT') return;
    /* Nothing answered yet — writing an empty draft would clobber the one the
       restore effect is in the middle of reading back. */
    if (Object.keys(answers).length === 0 && history.length === 0) return;
    saveDraft(spec, {
      formVersionId: spec.formVersionId,
      answers,
      stepHistory: history,
      currentStepId: stepId,
      startedAtMs: startedAtRef.current,
    });
  }, [spec, answers, history, stepId, phase]);

  /* ---- connectivity --------------------------------------------------- */
  useEffect(() => {
    const update = () => setOffline(globalThis.navigator?.onLine === false);
    update();
    globalThis.addEventListener?.('online', update);
    globalThis.addEventListener?.('offline', update);
    return () => {
      globalThis.removeEventListener?.('online', update);
      globalThis.removeEventListener?.('offline', update);
    };
  }, []);

  /* ---- focus management ----------------------------------------------- */
  useEffect(() => {
    if (!focusRequest) return;
    const container = globalThis.document?.querySelector(`[data-field="${focusRequest.fieldId}"]`);
    const control =
      container?.querySelector<HTMLElement>('input, select, textarea') ??
      (globalThis.document?.getElementById(fieldDomId(focusRequest.fieldId)) as HTMLElement | null);
    control?.focus();
  }, [focusRequest]);

  const step = getStep(spec, stepId);
  const fields = useMemo(
    () => (step ? visibleFields(spec, step, answers) : []),
    [spec, step, answers],
  );
  const progress = useMemo(
    () => (step ? computeProgress(spec, stepId, answers) : null),
    [spec, stepId, answers, step],
  );

  const setAnswer = useCallback((fieldId: string, value: AnswerValue) => {
    setAnswers((current) => ({ ...current, [fieldId]: value }));
    setErrors((current) => {
      if (!(fieldId in current)) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  }, []);

  const onBlurField = useCallback((_fieldId: string) => {
    /* Validation on blur is deliberately not wired: on a one-question-per-screen
       form it fires while the visitor is still deciding and reads as nagging.
       Errors appear when they try to advance, which is when they are useful. */
  }, []);

  const start = useCallback(() => {
    startedAtRef.current = Date.now();
    setPhase('STEP');
    tracker.formStarted();
    tracker.formStepViewed({ step_id: stepId });
  }, [tracker, stepId]);

  const submit = useCallback(
    async (currentAnswers: Answers) => {
      attemptIdRef.current ??= randomId();
      setSubmitError(null);
      tracker.leadSubmitAttempted();

      if (globalThis.navigator?.onLine === false) {
        setOffline(true);
        setSubmitError(OFFLINE_MESSAGE_DE);
        tracker.leadSubmitFailed();
        return;
      }

      setPhase('SUBMITTING');
      const elapsedSeconds = Math.round((Date.now() - startedAtRef.current) / 1000);

      try {
        const response = await fetch(submitEndpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            funnelVersionId,
            formVersionId: spec.formVersionId,
            formInstanceId,
            submissionAttemptId: attemptIdRef.current,
            answers: spec.submit.honeypotFieldId
              ? { ...currentAnswers, [spec.submit.honeypotFieldId]: honeypotRef.current }
              : currentAnswers,
            elapsedSeconds,
            stepsVisited: history.length + 1,
          }),
        });

        const body: unknown = await response.json().catch(() => null);

        if (!response.ok || !body || (body as SubmitSuccessBody).ok !== true) {
          const failure = (body ?? null) as SubmitErrorBody | null;
          if (failure?.fieldErrors && failure.fieldErrors.length > 0) {
            setErrors(byFieldId(failure.fieldErrors));
            const first = failure.fieldErrors[0];
            const owner = first ? stepOfField(spec, first.fieldId) : null;
            if (owner) setStepId(owner.stepId);
            if (first) setFocusRequest({ fieldId: first.fieldId, tick: Date.now() });
          }
          setSubmitError(failure?.messageDe ?? spec.submit.errorMessage);
          setPhase('STEP');
          tracker.leadSubmitFailed();
          return;
        }

        const success = body as SubmitSuccessBody;
        setResult(success);
        setPhase('RESULT');
        clearDraft(spec);
        tracker.leadSubmitted({ submission_id: success.submissionId });
        tracker.thankYouViewed({ submission_id: success.submissionId });
        tracker.flush();
        firePixelLead(success.pixel);
      } catch {
        /* Network failure. The attempt id is kept, so the retry is the same
           submission and cannot produce a second lead. */
        setSubmitError(spec.submit.errorMessage);
        setPhase('STEP');
        tracker.leadSubmitFailed();
      }
    },
    [funnelVersionId, formInstanceId, history.length, spec, submitEndpoint, tracker],
  );

  const goNext = useCallback(() => {
    if (!step) return;
    const validation = validateStep(spec, stepId, answers);
    if (!validation.ok) {
      setErrors(byFieldId(validation.errors));
      for (const error of validation.errors) {
        tracker.formValidationFailed({ field_id: error.fieldId, error_code: error.code });
      }
      const first = validation.errors[0];
      if (first) setFocusRequest({ fieldId: first.fieldId, tick: Date.now() });
      return;
    }

    setErrors({});
    tracker.formStepCompleted({ step_id: stepId });

    const target = nextTarget(spec, stepId, answers);
    if (!target) return;

    if (target.kind === 'STEP') {
      setHistory((current) => [...current, stepId]);
      setStepId(target.stepId);
      tracker.formStepViewed({ step_id: target.stepId });
      return;
    }
    if (target.kind === 'SUBMIT') {
      void submit(answers);
      return;
    }
    /* RESULT and DISQUALIFY end the flow without a submission — a disqualified
       visitor is never asked for contact data in the first place. */
    setTerminalVariantId(target.variantId);
    setPhase('RESULT');
    clearDraft(spec);
    tracker.thankYouViewed();
  }, [answers, spec, step, stepId, submit, tracker]);

  const goBack = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous === undefined) return;
    setHistory((current) => current.slice(0, -1));
    setStepId(previous);
    setErrors({});
    setSubmitError(null);
    tracker.formStepViewed({ step_id: previous });
  }, [history, tracker]);

  /* ---- terminal states ------------------------------------------------ */
  if (phase === 'RESULT') {
    const variantId = result?.resultVariantId ?? terminalVariantId;
    const variant: ResultVariant | null =
      spec.resultVariants.find((candidate) => candidate.variantId === variantId) ?? null;

    return (
      <div className="mx-auto grid w-full max-w-xl min-w-0 gap-4 px-4 py-6">
        <ResultView
          spec={spec}
          variant={variant}
          targets={targets}
          answers={answers}
          redirect={result?.redirect ?? null}
          onBookingStart={() => tracker.bookingStarted()}
        />
      </div>
    );
  }

  /* ---- intro ---------------------------------------------------------- */
  if (phase === 'INTRO') {
    return (
      <div className="mx-auto grid w-full max-w-xl min-w-0 gap-5 px-4 py-6">
        {spec.intro.eyebrow ? (
          <p className="break-words text-sm font-semibold uppercase tracking-wide text-brand">
            {spec.intro.eyebrow}
          </p>
        ) : null}
        <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground">
          {spec.intro.headline}
        </h1>
        {spec.intro.subline ? (
          <p className="break-words text-base leading-relaxed text-muted-foreground">
            {spec.intro.subline}
          </p>
        ) : null}
        {spec.intro.bullets.length > 0 ? (
          <ul className="grid min-w-0 gap-2">
            {spec.intro.bullets.map((bullet) => (
              <li key={bullet} className="min-w-0 break-words text-base">
                {bullet}
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" className={PRIMARY_BUTTON} onClick={start}>
          {spec.intro.primaryCtaLabel}
        </button>
        <div className="grid gap-1 text-sm text-muted-foreground">
          {spec.intro.effortPromise ? <p>Dauer: {spec.intro.effortPromise}</p> : null}
          {spec.intro.trustNote ? <p className="break-words">{spec.intro.trustNote}</p> : null}
        </div>
      </div>
    );
  }

  if (!step) return null;

  const submitting = phase === 'SUBMITTING';
  const isFinalStep = step.defaultNext.kind === 'SUBMIT';

  return (
    <form
      noValidate
      className="mx-auto grid w-full max-w-xl min-w-0 gap-5 px-4 py-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitting) goNext();
      }}
    >
      {step.showProgress && progress ? (
        <StepProgress progress={progress} style={spec.theme.progressStyle} />
      ) : null}

      <div className="grid min-w-0 gap-2">
        <h1
          ref={stepHeadingRef}
          tabIndex={-1}
          className="break-words text-xl font-semibold tracking-tight text-foreground outline-hidden"
        >
          {step.title}
        </h1>
        {step.subtitle ? (
          <p className="break-words text-base text-muted-foreground">{step.subtitle}</p>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-5">
        {fields.map((field) => (
          <FormFieldControl
            key={field.fieldId}
            spec={spec}
            field={field}
            value={answers[field.fieldId]}
            error={errors[field.fieldId] ?? null}
            onChange={setAnswer}
            onBlur={onBlurField}
            privacyTarget={targets.privacy}
          />
        ))}
      </div>

      {spec.submit.honeypotFieldId ? (
        <Honeypot
          fieldId={spec.submit.honeypotFieldId}
          value={honeypot}
          onChange={(value) => {
            honeypotRef.current = value;
            setHoneypot(value);
          }}
        />
      ) : null}

      {offline ? (
        <p
          role="status"
          className="flex min-w-0 items-start gap-2 rounded-[var(--am-radius)] border border-warning-border bg-warning-surface p-3 text-sm"
        >
          <WifiOff className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 break-words">{OFFLINE_MESSAGE_DE}</span>
        </p>
      ) : null}

      {submitError ? (
        <div
          role="alert"
          className="grid min-w-0 gap-2 rounded-[var(--am-radius)] border border-destructive-border bg-destructive-surface p-3"
        >
          <p className="flex min-w-0 items-start gap-2 text-sm text-foreground">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words">{submitError}</span>
          </p>
          {isFinalStep ? (
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => void submit(answers)}
              disabled={submitting}
            >
              Erneut senden
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="grid min-w-0 gap-3">
        <button type="submit" className={PRIMARY_BUTTON} disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden="true" />
              {spec.submit.submittingLabel}
            </>
          ) : (
            step.primaryCtaLabel
          )}
        </button>
        {history.length > 0 && step.secondaryCtaLabel ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={goBack}
            disabled={submitting}
          >
            <ArrowLeft className="size-5 shrink-0" aria-hidden="true" />
            {step.secondaryCtaLabel}
          </button>
        ) : null}
      </div>
    </form>
  );
}
