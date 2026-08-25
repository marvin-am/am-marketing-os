import type {
  ClientEventType,
  ConsentStatus,
  TrackingContext,
  ValidationErrorCode,
} from '@am/domain';

/**
 * The browser-side tracker.
 *
 * Deliberately dependency-free at runtime — the only imports are types, which
 * disappear at build time. The funnel is a mobile-first landing page whose
 * conversion rate is measurably sensitive to payload size, so this file ships no
 * validation library, no framework binding and no polyfill.
 *
 * It is also safe to import from a server file: every `window`, `navigator` and
 * `document` access goes through `globalThis` behind a capability check, so a
 * module-level import in a React Server Component does not explode.
 */

/* -------------------------------------------------------------------------- */
/* Client-side PII guard                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Mirror of `FORBIDDEN_EVENT_KEYS` in `@am/domain`. It is duplicated rather than
 * imported because importing the domain module would pull Zod into the funnel
 * bundle for a list of strings. `beacon.test.ts` asserts the two lists stay
 * identical, so the copy cannot drift unnoticed.
 *
 * The authoritative guard is the server-side one in `collector.ts`; this is the
 * fail-fast that stops a mistake from ever leaving the browser.
 */
export const CLIENT_FORBIDDEN_KEYS: readonly string[] = [
  'email',
  'e_mail',
  'mail',
  'phone',
  'telefon',
  'telephone',
  'first_name',
  'firstname',
  'vorname',
  'last_name',
  'lastname',
  'nachname',
  'name',
  'full_name',
  'answers',
  'answer',
  'antworten',
  'message',
  'nachricht',
  'freitext',
  'address',
  'adresse',
  'street',
  'ip',
  'ip_address',
  'user_agent',
];

const EMAIL_LIKE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_LIKE = /(?:\+|00)\d[\d\s\-()]{7,}/;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Paths in `payload` that look like personal data. Empty means clean. */
export function findClientPiiViolations(payload: unknown, path = '$'): string[] {
  const violations: string[] = [];

  const walk = (value: unknown, currentPath: string): void => {
    if (value === null || value === undefined) return;

    if (typeof value === 'string') {
      if (EMAIL_LIKE.test(value)) violations.push(`${currentPath} (E-Mail-Muster)`);
      else if (PHONE_LIKE.test(value) && !UUID_LIKE.test(value)) {
        violations.push(`${currentPath} (Telefonnummer-Muster)`);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }

    if (typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (CLIENT_FORBIDDEN_KEYS.includes(key.toLowerCase())) {
          violations.push(`${currentPath}.${key} (verbotener Schlüssel)`);
          continue;
        }
        walk((value as Record<string, unknown>)[key], `${currentPath}.${key}`);
      }
    }
  };

  walk(payload, path);
  return violations;
}

export function assertNoClientPii(payload: unknown): void {
  const violations = findClientPiiViolations(payload);
  if (violations.length > 0) {
    throw new Error(`Analytics-Payload enthält personenbezogene Daten: ${violations.join(', ')}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Environment probes                                                          */
/* -------------------------------------------------------------------------- */

function hasWindow(): boolean {
  return typeof globalThis.window !== 'undefined';
}

function canSendBeacon(): boolean {
  return (
    typeof globalThis.navigator !== 'undefined' &&
    typeof globalThis.navigator.sendBeacon === 'function'
  );
}

function canFetch(): boolean {
  return typeof globalThis.fetch === 'function';
}

/** RFC 4122 v4, with graceful degradation on browsers without `randomUUID`. */
function randomUuid(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i] as number).toString(16).padStart(2, '0'));
  const joined = hex.join('');
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20),
  ].join('-');
}

/* -------------------------------------------------------------------------- */
/* Tracker                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The context the server injected into the page. Snake_case on purpose: it is
 * literally a partial event envelope, which keeps the wire format obvious.
 */
export interface TrackerContext extends Partial<TrackingContext> {
  visitor_id: string;
  session_id: string;
  consent_status?: ConsentStatus;
  form_instance_id?: string | null;
  referrer?: string | null;
  landing_url?: string | null;
}

export interface TrackProps {
  form_instance_id?: string | null;
  submission_id?: string | null;
  step_id?: string | null;
  field_id?: string | null;
  error_code?: ValidationErrorCode | null;
  experiment_id?: string | null;
  experiment_arm_id?: string | null;
  consent_status?: ConsentStatus;
  /** Small non-PII extras only: step index, viewport bucket, duration buckets. */
  metadata?: Record<string, string | number | boolean>;
}

export interface QueuedEvent extends TrackProps, Partial<TrackingContext> {
  event_id: string;
  event_type: ClientEventType;
  event_schema_version: 1;
  occurred_at: string;
  visitor_id: string;
  session_id: string;
  referrer?: string | null;
  landing_url?: string | null;
}

/** Hands a serialised batch to the network. Returns false if it could not. */
export type BeaconTransport = (endpoint: string, body: string) => boolean;

export interface TrackerOptions {
  /** First-party collector endpoint, e.g. `/api/track`. */
  endpoint: string;
  context: TrackerContext;
  /** Flush once this many events are queued. */
  batchSize?: number;
  /** Flush a partial batch after this long. */
  flushIntervalMs?: number;
  /** Hard cap; beyond it the oldest events are dropped rather than growing forever. */
  maxQueueSize?: number;
  /** Throw instead of dropping when a payload trips the PII guard. */
  strict?: boolean;
  transport?: BeaconTransport;
  now?: () => Date;
  onError?: (error: Error) => void;
}

export interface Tracker {
  track(eventType: ClientEventType, props?: TrackProps): void;
  funnelViewed(props?: TrackProps): void;
  experimentExposed(props: TrackProps & { experiment_id: string; experiment_arm_id: string }): void;
  formViewed(props?: TrackProps): void;
  formStarted(props?: TrackProps): void;
  formStepViewed(props: TrackProps & { step_id: string }): void;
  formStepCompleted(props: TrackProps & { step_id: string }): void;
  /** Only the field key and a standardised code — never the value typed in. */
  formValidationFailed(
    props: TrackProps & { field_id: string; error_code: ValidationErrorCode },
  ): void;
  leadSubmitAttempted(props?: TrackProps): void;
  leadSubmitted(props?: TrackProps): void;
  leadSubmitFailed(props?: TrackProps): void;
  thankYouViewed(props?: TrackProps): void;
  bookingStarted(props?: TrackProps): void;
  /** Sends whatever is queued. Safe to call repeatedly. */
  flush(): void;
  pending(): number;
  /** Flushes and detaches listeners and timers. */
  destroy(): void;
}

export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_FLUSH_INTERVAL_MS = 4_000;
export const DEFAULT_MAX_QUEUE_SIZE = 100;

function defaultTransport(endpoint: string, body: string): boolean {
  if (canSendBeacon()) {
    try {
      const blob = new Blob([body], { type: 'application/json' });
      if (globalThis.navigator.sendBeacon(endpoint, blob)) return true;
    } catch {
      // Fall through to fetch — sendBeacon throws on oversized payloads.
    }
  }

  if (canFetch()) {
    // `keepalive` is what lets the request outlive the page it was fired from.
    void globalThis
      .fetch(endpoint, {
        method: 'POST',
        body,
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      })
      .catch(() => undefined);
    return true;
  }

  return false;
}

export function createTracker(options: TrackerOptions): Tracker {
  const {
    endpoint,
    context,
    batchSize = DEFAULT_BATCH_SIZE,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    strict = false,
    transport = defaultTransport,
    now = () => new Date(),
    onError,
  } = options;

  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const report = (error: Error): void => {
    if (onError) onError(error);
    else if (typeof console !== 'undefined') console.warn(`[tracking] ${error.message}`);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleFlush = (): void => {
    if (timer !== null || destroyed || !hasWindow()) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushIntervalMs);
  };

  const flush = (): void => {
    clearTimer();
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    const body = JSON.stringify({ events: batch });
    if (!transport(endpoint, body)) {
      report(new Error('Kein Transport für Tracking-Ereignisse verfügbar.'));
    }
  };

  const enqueue = (event: QueuedEvent): void => {
    if (destroyed) return;

    const violations = findClientPiiViolations(event);
    if (violations.length > 0) {
      const error = new Error(
        `Ereignis verworfen — personenbezogene Daten: ${violations.join(', ')}`,
      );
      if (strict) throw error;
      report(error);
      return;
    }

    if (queue.length >= maxQueueSize) queue.shift();
    queue.push(event);

    if (queue.length >= batchSize) flush();
    else scheduleFlush();
  };

  const track = (eventType: ClientEventType, props: TrackProps = {}): void => {
    const { referrer, landing_url: landingUrl, ...contextIds } = context;
    // Referrer and landing URL belong to the entry event only; repeating a
    // 2 kB URL on every step would triple the payload for no extra information.
    const entryFields =
      eventType === 'funnel_viewed'
        ? { referrer: referrer ?? null, landing_url: landingUrl ?? null }
        : {};

    enqueue({
      ...contextIds,
      ...entryFields,
      ...props,
      metadata: props.metadata ?? {},
      event_id: randomUuid(),
      event_type: eventType,
      event_schema_version: 1,
      occurred_at: now().toISOString(),
      visitor_id: context.visitor_id,
      session_id: context.session_id,
    });
  };

  // Page lifecycle flushes. Note that this is only about getting queued events
  // out of a page that is going away — `form_abandoned` itself is derived
  // server-side from inactivity, never from a lifecycle event.
  const onHidden = (): void => {
    if (globalThis.document?.visibilityState === 'hidden') flush();
  };
  const onPageHide = (): void => flush();

  if (hasWindow() && typeof globalThis.document?.addEventListener === 'function') {
    globalThis.document.addEventListener('visibilitychange', onHidden);
    globalThis.window.addEventListener('pagehide', onPageHide);
  }

  return {
    track,
    funnelViewed: (props) => track('funnel_viewed', props),
    experimentExposed: (props) => track('experiment_exposed', props),
    formViewed: (props) => track('form_viewed', props),
    formStarted: (props) => track('form_started', props),
    formStepViewed: (props) => track('form_step_viewed', props),
    formStepCompleted: (props) => track('form_step_completed', props),
    formValidationFailed: (props) => track('form_validation_failed', props),
    leadSubmitAttempted: (props) => track('lead_submit_attempted', props),
    leadSubmitted: (props) => track('lead_submitted', props),
    leadSubmitFailed: (props) => track('lead_submit_failed', props),
    thankYouViewed: (props) => track('thank_you_viewed', props),
    bookingStarted: (props) => track('booking_started', props),
    flush,
    pending: () => queue.length,
    destroy: () => {
      flush();
      destroyed = true;
      clearTimer();
      if (hasWindow() && typeof globalThis.document?.removeEventListener === 'function') {
        globalThis.document.removeEventListener('visibilitychange', onHidden);
        globalThis.window.removeEventListener('pagehide', onPageHide);
      }
    },
  };
}
