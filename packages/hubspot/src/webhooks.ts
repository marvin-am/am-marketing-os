import { z } from 'zod';
import { DomainError, nowIso, type IsoTimestamp, type SalesEventType } from '@am/domain';
import type { HubspotMappingDocument } from './mapping/schema';
import { toCanonicalEvents } from './mapping/translate';
import type { CanonicalEventDraft, ObjectSnapshot, PropertyBag } from './types';
import type { SyncStore } from './sync';

/**
 * Inbound HubSpot webhooks.
 *
 * The body is never parsed, logged or acted upon before the signature verifies.
 * A webhook endpoint is a public, unauthenticated URL: treating its payload as
 * trustworthy is the whole vulnerability.
 */

export const HUBSPOT_SIGNATURE_HEADER = 'x-hubspot-signature-v3';
export const HUBSPOT_TIMESTAMP_HEADER = 'x-hubspot-request-timestamp';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface WebhookRequest {
  method: string;
  /** The full request URI exactly as HubSpot called it, query string included. */
  url: string;
  /** The unparsed body. Re-serialising JSON breaks the signature. */
  rawBody: string;
  headers: Record<string, string | undefined>;
}

export const WEBHOOK_REJECTION_REASONS = [
  'SECRET_NOT_CONFIGURED',
  'MISSING_SIGNATURE',
  'MISSING_TIMESTAMP',
  'TIMESTAMP_OUT_OF_WINDOW',
  'SIGNATURE_MISMATCH',
  'PAYLOAD_INVALID',
] as const;
export type WebhookRejectionReason = (typeof WEBHOOK_REJECTION_REASONS)[number];

export const WEBHOOK_REJECTION_MESSAGES_DE: Readonly<Record<WebhookRejectionReason, string>> = {
  SECRET_NOT_CONFIGURED:
    'Es ist kein HubSpot-Webhook-Secret hinterlegt; eingehende Webhooks werden abgelehnt.',
  MISSING_SIGNATURE: 'Die Anfrage enthält keine HubSpot-Signatur.',
  MISSING_TIMESTAMP: 'Die Anfrage enthält keinen HubSpot-Zeitstempel.',
  TIMESTAMP_OUT_OF_WINDOW:
    'Der Zeitstempel der Anfrage liegt außerhalb des zulässigen Zeitfensters (mögliche Wiedereinspielung).',
  SIGNATURE_MISMATCH: 'Die Signatur der Anfrage ist ungültig.',
  PAYLOAD_INVALID: 'Der Inhalt der Anfrage entspricht nicht dem erwarteten HubSpot-Format.',
};

export interface WebhookVerification {
  verified: boolean;
  reason: WebhookRejectionReason | null;
  messageDe: string | null;
}

export interface VerifySignatureOptions {
  secret: string | null;
  toleranceSeconds?: number;
  now?: () => IsoTimestamp;
}

function headerValue(headers: WebhookRequest['headers'], name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined) return value;
  }
  return null;
}

function base64ToBytes(input: string): Uint8Array | null {
  try {
    const binary = atob(input);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * HubSpot v3 signature: base64(HMAC-SHA256(method + uri + rawBody + timestamp)).
 *
 * Verification runs through `crypto.subtle.verify`, which compares in constant
 * time. Requests older than the tolerance window are rejected before the HMAC is
 * computed at all, which is what closes the replay hole.
 */
export async function verifyHubspotSignature(
  request: WebhookRequest,
  options: VerifySignatureOptions,
): Promise<WebhookVerification> {
  const reject = (reason: WebhookRejectionReason): WebhookVerification => ({
    verified: false,
    reason,
    messageDe: WEBHOOK_REJECTION_MESSAGES_DE[reason],
  });

  if (!options.secret) return reject('SECRET_NOT_CONFIGURED');

  const signature = headerValue(request.headers, HUBSPOT_SIGNATURE_HEADER);
  if (!signature) return reject('MISSING_SIGNATURE');

  const timestampRaw = headerValue(request.headers, HUBSPOT_TIMESTAMP_HEADER);
  if (!timestampRaw) return reject('MISSING_TIMESTAMP');

  const timestampMs = Number(timestampRaw);
  if (!Number.isFinite(timestampMs)) return reject('MISSING_TIMESTAMP');

  const nowMs = Date.parse((options.now ?? nowIso)());
  const toleranceMs = (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  if (Math.abs(nowMs - timestampMs) > toleranceMs) return reject('TIMESTAMP_OUT_OF_WINDOW');

  const signatureBytes = base64ToBytes(signature);
  if (!signatureBytes) return reject('SIGNATURE_MISMATCH');

  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(options.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const payload = encoder.encode(
    `${request.method.toUpperCase()}${request.url}${request.rawBody}${timestampRaw}`,
  );
  const valid = await globalThis.crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes as unknown as ArrayBuffer,
    payload as unknown as ArrayBuffer,
  );

  return valid
    ? { verified: true, reason: null, messageDe: null }
    : reject('SIGNATURE_MISMATCH');
}

/** Test/tooling helper: produces the signature HubSpot would send. */
export async function signHubspotRequest(
  request: Omit<WebhookRequest, 'headers'>,
  secret: string,
  timestampMs: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = encoder.encode(
    `${request.method.toUpperCase()}${request.url}${request.rawBody}${timestampMs}`,
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    payload as unknown as ArrayBuffer,
  );
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* -------------------------------------------------------------------------- */
/* Payload                                                                     */
/* -------------------------------------------------------------------------- */

const idLike = z.union([z.number(), z.string()]).transform((v) => String(v));

export const hubspotWebhookEventSchema = z.object({
  eventId: idLike,
  subscriptionId: idLike.nullish(),
  portalId: idLike.nullish(),
  appId: idLike.nullish(),
  occurredAt: z.number().int(),
  subscriptionType: z.string().min(1).max(120),
  attemptNumber: z.number().int().nullish(),
  objectId: idLike,
  changeSource: z.string().max(80).nullish(),
  propertyName: z.string().max(120).nullish(),
  propertyValue: z
    .union([z.string(), z.number(), z.boolean()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? null : String(v))),
});
export type HubspotWebhookEvent = z.infer<typeof hubspotWebhookEventSchema>;

export const hubspotWebhookPayloadSchema = z.array(hubspotWebhookEventSchema).max(500);

/** Parses a *verified* body. Never call this before `verifyHubspotSignature`. */
export function parseWebhookPayload(rawBody: string): HubspotWebhookEvent[] {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch (cause) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: WEBHOOK_REJECTION_MESSAGES_DE.PAYLOAD_INVALID,
      cause,
    });
  }
  const parsed = hubspotWebhookPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: WEBHOOK_REJECTION_MESSAGES_DE.PAYLOAD_INVALID,
      details: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
    });
  }
  return parsed.data;
}

/** Maps a `contact.propertyChange`-style subscription onto a mapped object type. */
export function subscriptionObjectType(
  subscriptionType: string,
  mapping: HubspotMappingDocument,
): string | null {
  const prefix = subscriptionType.split('.')[0]?.toLowerCase() ?? '';
  switch (prefix) {
    case 'contact':
      return mapping.objects.contact;
    case 'company':
      return mapping.objects.company;
    case 'deal':
      return mapping.objects.deal;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Dedup                                                                       */
/* -------------------------------------------------------------------------- */

export interface WebhookDedupe {
  seen(eventId: string): Promise<boolean>;
  remember(eventId: string): Promise<void>;
}

export function createInMemoryWebhookDedupe(limit = 5_000): WebhookDedupe {
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    async seen(eventId) {
      return seen.has(eventId);
    },
    async remember(eventId) {
      if (seen.has(eventId)) return;
      seen.add(eventId);
      order.push(eventId);
      while (order.length > limit) {
        const oldest = order.shift();
        if (oldest !== undefined) seen.delete(oldest);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Handling                                                                    */
/* -------------------------------------------------------------------------- */

export type WebhookStore = Pick<
  SyncStore,
  'loadMirror' | 'saveMirror' | 'appendSalesEvents' | 'listSalesEventTypes'
>;

export interface WebhookDeps {
  secret: string | null;
  mapping: HubspotMappingDocument;
  store: WebhookStore;
  dedupe?: WebhookDedupe;
  now?: () => IsoTimestamp;
  toleranceSeconds?: number;
}

export interface WebhookResult {
  verified: boolean;
  rejection: WebhookRejectionReason | null;
  messageDe: string;
  received: number;
  duplicates: number;
  /** Canonical events the payload implies — only genuine transitions. */
  events: CanonicalEventDraft[];
  /** Of those, the ones the store had not already recorded. */
  appended: CanonicalEventDraft[];
}

/**
 * Verifies, parses, deduplicates and translates one webhook delivery.
 *
 * A repeated delivery of the same `eventId`, and a delivery that reports a value
 * we already mirror, both produce zero events.
 */
export async function handleHubspotWebhook(
  request: WebhookRequest,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  const now = deps.now ?? nowIso;
  const verification = await verifyHubspotSignature(request, {
    secret: deps.secret,
    toleranceSeconds: deps.toleranceSeconds ?? deps.mapping.webhook.toleranceSeconds,
    now,
  });

  if (!verification.verified) {
    return {
      verified: false,
      rejection: verification.reason,
      messageDe: verification.messageDe ?? WEBHOOK_REJECTION_MESSAGES_DE.SIGNATURE_MISMATCH,
      received: 0,
      duplicates: 0,
      events: [],
      appended: [],
    };
  }

  const payload = parseWebhookPayload(request.rawBody);
  const dedupe = deps.dedupe;
  const fresh: HubspotWebhookEvent[] = [];
  let duplicates = 0;

  for (const event of payload) {
    if (dedupe && (await dedupe.seen(event.eventId))) {
      duplicates += 1;
      continue;
    }
    fresh.push(event);
    await dedupe?.remember(event.eventId);
  }

  const grouped = groupByObject(fresh, deps.mapping);
  const events: CanonicalEventDraft[] = [];

  for (const group of grouped) {
    const before = await deps.store.loadMirror(group.objectType, group.objectId);
    const after: ObjectSnapshot = {
      objectType: group.objectType,
      objectId: group.objectId,
      properties: { ...(before?.properties ?? {}), ...group.properties },
      observedAt: group.occurredAt,
    };

    const emitted = await deps.store.listSalesEventTypes(group.objectId);
    events.push(
      ...toCanonicalEvents({
        before,
        after,
        mapping: deps.mapping,
        sourceObject: 'WEBHOOK',
        emittedEventTypes: emitted as SalesEventType[],
        sourceEventId: group.sourceEventId,
      }),
    );
    await deps.store.saveMirror(after);
  }

  const appended = events.length > 0 ? await deps.store.appendSalesEvents(events) : [];

  return {
    verified: true,
    rejection: null,
    messageDe:
      appended.length > 0
        ? `${appended.length} Zustandsänderung(en) aus HubSpot übernommen.`
        : 'Webhook verarbeitet; es lag keine echte Zustandsänderung vor.',
    received: payload.length,
    duplicates,
    events,
    appended,
  };
}

interface WebhookObjectGroup {
  objectType: string;
  objectId: string;
  properties: PropertyBag;
  occurredAt: IsoTimestamp;
  sourceEventId: string;
}

function groupByObject(
  events: readonly HubspotWebhookEvent[],
  mapping: HubspotMappingDocument,
): WebhookObjectGroup[] {
  const groups = new Map<string, WebhookObjectGroup>();

  for (const event of events) {
    const objectType = subscriptionObjectType(event.subscriptionType, mapping);
    if (!objectType) continue;
    const key = `${objectType}:${event.objectId}`;
    const occurredAt = new Date(event.occurredAt).toISOString();

    const existing = groups.get(key);
    if (existing) {
      if (event.propertyName) existing.properties[event.propertyName] = event.propertyValue;
      if (occurredAt > existing.occurredAt) existing.occurredAt = occurredAt;
      continue;
    }

    const properties: PropertyBag = {};
    if (event.propertyName) properties[event.propertyName] = event.propertyValue;
    groups.set(key, {
      objectType,
      objectId: event.objectId,
      properties,
      occurredAt,
      sourceEventId: event.eventId,
    });
  }

  return [...groups.values()];
}
