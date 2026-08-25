import type { PixelPayload } from '@am/meta';

/**
 * Hands the accepted lead to the Meta pixel — if one is already on the page.
 *
 * This funnel deliberately ships **no vendor analytics bundle**. Loading
 * `fbevents.js` from the critical path of a mobile ad click costs render-
 * blocking bytes and a third-party connection for a signal the server sends
 * anyway through the Conversions API. So the runtime never injects the pixel; it
 * calls `fbq` only when a tag manager outside this app has already defined it.
 *
 * What matters either way is the `eventID`: it is the same id the server event
 * carries (`sha256('lead:<submission_id>')`), which is exactly what Meta
 * deduplicates the browser/server pair on. If no pixel is present the server
 * event stands alone — which is the correct, complete signal, not a degraded
 * one.
 */

type FbqFunction = (
  command: 'track',
  eventName: string,
  customData?: Record<string, unknown>,
  options?: { eventID: string },
) => void;

function fbq(): FbqFunction | null {
  const candidate = (globalThis as { fbq?: unknown }).fbq;
  return typeof candidate === 'function' ? (candidate as FbqFunction) : null;
}

/** True when the event was handed to a pixel that actually exists. */
export function firePixelLead(payload: PixelPayload | null): boolean {
  if (!payload) return false;
  const track = fbq();
  if (!track) return false;
  try {
    track('track', payload.eventName, payload.customData ?? {}, { eventID: payload.eventID });
    return true;
  } catch {
    /* A broken third-party tag must never take the thank-you screen down. */
    return false;
  }
}
