import { getField, isContactField, type Answers, type MultiStepFormSpec } from '@am/funnel-schema';

/**
 * Draft persistence for a partially completed form.
 *
 * A visitor who reloads mid-form, rotates their phone, or follows a link and
 * comes back must not lose four answered questions — that is a pure abandonment
 * driver on mobile. So the answers are kept.
 *
 * What is *not* kept is contact data. Session storage is unencrypted, readable
 * by any script on the origin, and survives long enough to matter on a shared
 * device. Name, e-mail and phone number therefore never leave React state:
 * `splitAnswers`' own rule is mirrored here — a field is stored only when it is
 * neither `PII` nor an inherently personal type, and a field the spec does not
 * know is treated as personal. Failing closed is the only acceptable direction.
 *
 * `sessionStorage` rather than `localStorage`: the draft belongs to this visit.
 * Every access is wrapped, because Safari's private mode throws on write and a
 * storage quota error must never take the form down with it.
 */

export const STORAGE_VERSION = 1;

export interface StoredDraft {
  version: number;
  formVersionId: string;
  /** Non-PII answers only. */
  answers: Answers;
  stepHistory: string[];
  currentStepId: string | null;
  startedAtMs: number;
}

export function storageKeyFor(formVersionId: string): string {
  return `am_funnel_draft:${formVersionId}`;
}

/** Answers that may be written to the browser. Contact data is dropped. */
export function storableAnswers(spec: MultiStepFormSpec, answers: Answers): Answers {
  const safe: Answers = {};
  for (const [fieldId, value] of Object.entries(answers)) {
    const field = getField(spec, fieldId);
    if (!field) continue;
    if (field.piiClass === 'PII' || isContactField(field)) continue;
    safe[fieldId] = value;
  }
  return safe;
}

function storage(): Storage | null {
  try {
    return typeof globalThis.sessionStorage !== 'undefined' ? globalThis.sessionStorage : null;
  } catch {
    return null;
  }
}

export function saveDraft(spec: MultiStepFormSpec, draft: Omit<StoredDraft, 'version'>): void {
  const store = storage();
  if (!store) return;
  const payload: StoredDraft = {
    ...draft,
    version: STORAGE_VERSION,
    answers: storableAnswers(spec, draft.answers),
  };
  try {
    store.setItem(storageKeyFor(spec.formVersionId), JSON.stringify(payload));
  } catch {
    /* Quota or private mode. A lost draft is a worse experience, not a broken
       one — the form keeps working from React state. */
  }
}

export function loadDraft(spec: MultiStepFormSpec): StoredDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(storageKeyFor(spec.formVersionId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const draft = parsed as Partial<StoredDraft>;
    if (draft.version !== STORAGE_VERSION) return null;
    if (draft.formVersionId !== spec.formVersionId) return null;
    return {
      version: STORAGE_VERSION,
      formVersionId: spec.formVersionId,
      /* Re-filter on read: a draft written by an older build, or edited by
         hand, must not be able to reintroduce contact data. */
      answers: storableAnswers(spec, (draft.answers ?? {}) as Answers),
      stepHistory: Array.isArray(draft.stepHistory) ? draft.stepHistory.map(String) : [],
      currentStepId: typeof draft.currentStepId === 'string' ? draft.currentStepId : null,
      startedAtMs: typeof draft.startedAtMs === 'number' ? draft.startedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

export function clearDraft(spec: MultiStepFormSpec): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(storageKeyFor(spec.formVersionId));
  } catch {
    /* Nothing to do — the draft simply expires with the session. */
  }
}
