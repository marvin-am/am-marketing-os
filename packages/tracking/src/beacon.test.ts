import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_EVENT_KEYS, FORBIDDEN_EVENT_KEY_FRAGMENTS, FORBIDDEN_EVENT_KEYS_EXACT } from '@am/domain';
import {
  assertNoClientPii,
  CLIENT_FORBIDDEN_KEYS,
  CLIENT_FORBIDDEN_KEY_FRAGMENTS,
  CLIENT_FORBIDDEN_KEYS_EXACT,
  createTracker,
  findClientPiiViolations,
  type QueuedEvent,
  type TrackerContext,
} from './beacon';
import { normalizeEvent, type CollectorContext } from './collector';

const context: TrackerContext = {
  visitor_id: randomUUID(),
  session_id: randomUUID(),
  campaign_id: randomUUID(),
  funnel_version_id: randomUUID(),
  form_version_id: randomUUID(),
  referrer: 'https://l.facebook.com/',
  landing_url: 'https://funnel.example.com/l/steuerkanzlei?am_t=v1.abc.def',
};

function collect() {
  const batches: QueuedEvent[][] = [];
  const transport = vi.fn((_endpoint: string, body: string) => {
    batches.push((JSON.parse(body) as { events: QueuedEvent[] }).events);
    return true;
  });
  return { batches, transport };
}

describe('client-side PII guard', () => {
  it('mirrors the domain key lists exactly', () => {
    // The beacon keeps its own copy so the funnel bundle stays Zod-free; this
    // is what stops the two drifting.
    expect([...CLIENT_FORBIDDEN_KEYS]).toEqual([...FORBIDDEN_EVENT_KEYS]);
    expect([...CLIENT_FORBIDDEN_KEY_FRAGMENTS]).toEqual([...FORBIDDEN_EVENT_KEY_FRAGMENTS]);
    expect([...CLIENT_FORBIDDEN_KEYS_EXACT]).toEqual([...FORBIDDEN_EVENT_KEYS_EXACT]);
  });

  it('matches key variants the way the domain does', () => {
    expect(findClientPiiViolations({ phone_number: '123' })).toHaveLength(1);
    expect(findClientPiiViolations({ emailAddress: 'x' })).toHaveLength(1);
    // …without rejecting legitimate keys that merely contain an ambiguous word.
    expect(findClientPiiViolations({ content_name: 'Potenzialanalyse' })).toEqual([]);
  });

  it('catches the German national phone format', () => {
    expect(findClientPiiViolations({ v: '0151 23456789' })).toHaveLength(1);
  });

  it('flags e-mails, phone numbers and forbidden keys', () => {
    expect(findClientPiiViolations({ a: 'max@example.de' })).toHaveLength(1);
    expect(findClientPiiViolations({ a: '+49 170 1234567' })).toHaveLength(1);
    expect(findClientPiiViolations({ answers: { x: 1 } })).toHaveLength(1);
    expect(findClientPiiViolations({ step_id: 'kontakt', v: randomUUID() })).toEqual([]);
    expect(() => assertNoClientPii({ email: 'x' })).toThrow();
  });
});

describe('createTracker', () => {
  it('batches events and flushes them as one request', () => {
    const { batches, transport } = collect();
    const tracker = createTracker({ endpoint: '/api/track', context, batchSize: 3, transport });

    tracker.funnelViewed();
    tracker.formViewed({ form_instance_id: randomUUID() });
    expect(transport).not.toHaveBeenCalled();
    expect(tracker.pending()).toBe(2);

    tracker.formStarted({ form_instance_id: randomUUID() });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(batches[0]).toHaveLength(3);
    expect(tracker.pending()).toBe(0);
  });

  it('flushes a partial batch on demand and on destroy', () => {
    const { batches, transport } = collect();
    const tracker = createTracker({ endpoint: '/api/track', context, batchSize: 10, transport });

    tracker.funnelViewed();
    tracker.flush();
    expect(batches[0]).toHaveLength(1);

    tracker.thankYouViewed();
    tracker.destroy();
    expect(batches[1]).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('emits the mandated event types with their identifiers', () => {
    const { batches, transport } = collect();
    const tracker = createTracker({ endpoint: '/api/track', context, batchSize: 100, transport });
    const formInstanceId = randomUUID();
    const submissionId = randomUUID();

    tracker.funnelViewed();
    tracker.experimentExposed({ experiment_id: randomUUID(), experiment_arm_id: randomUUID() });
    tracker.formViewed({ form_instance_id: formInstanceId });
    tracker.formStarted({ form_instance_id: formInstanceId });
    tracker.formStepViewed({ form_instance_id: formInstanceId, step_id: 'bedarf' });
    tracker.formStepCompleted({ form_instance_id: formInstanceId, step_id: 'bedarf' });
    tracker.formValidationFailed({ field_id: 'email', error_code: 'INVALID_EMAIL' });
    tracker.leadSubmitAttempted({ form_instance_id: formInstanceId });
    tracker.leadSubmitted({ form_instance_id: formInstanceId, submission_id: submissionId });
    tracker.leadSubmitFailed({ error_code: 'SERVER_REJECTED' });
    tracker.thankYouViewed({ submission_id: submissionId });
    tracker.bookingStarted({ submission_id: submissionId });
    tracker.flush();

    expect(batches[0]?.map((event) => event.event_type)).toEqual([
      'funnel_viewed',
      'experiment_exposed',
      'form_viewed',
      'form_started',
      'form_step_viewed',
      'form_step_completed',
      'form_validation_failed',
      'lead_submit_attempted',
      'lead_submitted',
      'lead_submit_failed',
      'thank_you_viewed',
      'booking_started',
    ]);
  });

  it('carries the referrer and landing URL on the entry event only', () => {
    const { batches, transport } = collect();
    const tracker = createTracker({ endpoint: '/api/track', context, batchSize: 100, transport });

    tracker.funnelViewed();
    tracker.formViewed();
    tracker.flush();

    expect(batches[0]?.[0]?.landing_url).toBe(context.landing_url);
    expect(batches[0]?.[0]?.campaign_id).toBe(context.campaign_id);
    expect(batches[0]?.[1]?.landing_url).toBeUndefined();
    expect(batches[0]?.[1]?.campaign_id).toBe(context.campaign_id);
  });

  it('sends a validation failure without the value the visitor typed', () => {
    const { batches, transport } = collect();
    const tracker = createTracker({ endpoint: '/api/track', context, batchSize: 1, transport });

    tracker.formValidationFailed({
      form_instance_id: randomUUID(),
      step_id: 'kontakt',
      field_id: 'email',
      error_code: 'INVALID_EMAIL',
    });

    const event = batches[0]?.[0];
    expect(event?.field_id).toBe('email');
    expect(event?.error_code).toBe('INVALID_EMAIL');
    expect(JSON.stringify(event)).not.toContain('@');
  });

  it('never enqueues an event carrying PII', () => {
    const onError = vi.fn();
    const { transport } = collect();
    const tracker = createTracker({ endpoint: '/api/track', context, batchSize: 1, transport, onError });

    tracker.track('lead_submitted', { metadata: { contact: 'max@example.de' } });

    expect(transport).not.toHaveBeenCalled();
    expect(tracker.pending()).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message).toContain('personenbezogene Daten');
  });

  it('throws instead of dropping when strict', () => {
    const { transport } = collect();
    const tracker = createTracker({
      endpoint: '/api/track',
      context,
      batchSize: 1,
      transport,
      strict: true,
    });

    expect(() => tracker.track('lead_submitted', { metadata: { phone: '1' } })).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('drops the oldest event rather than growing without bound', () => {
    const { batches, transport } = collect();
    const tracker = createTracker({
      endpoint: '/api/track',
      context,
      batchSize: 1_000,
      maxQueueSize: 3,
      transport,
    });

    for (let i = 0; i < 5; i++) tracker.formStepViewed({ step_id: `schritt_${i}` });
    tracker.flush();

    expect(batches[0]).toHaveLength(3);
    expect(batches[0]?.[0]?.step_id).toBe('schritt_2');
  });

  it('is safe to construct on the server, where there is no window', () => {
    expect(typeof globalThis.window).toBe('undefined');
    const { batches, transport } = collect();
    const tracker = createTracker({ endpoint: '/api/track', context, batchSize: 1, transport });
    tracker.funnelViewed();
    expect(batches[0]).toHaveLength(1);
    tracker.destroy();
  });

  it('produces events the server collector accepts unchanged', () => {
    const { batches, transport } = collect();
    const tracker = createTracker({ endpoint: '/api/track', context, batchSize: 100, transport });
    const ctx: CollectorContext = { environment: 'production', trafficKind: 'PRODUCTION' };

    tracker.funnelViewed();
    tracker.formStepViewed({ form_instance_id: randomUUID(), step_id: 'bedarf', metadata: { index: 2 } });
    tracker.formValidationFailed({ field_id: 'plz', error_code: 'INVALID_POSTCODE' });
    tracker.flush();

    for (const event of batches[0] ?? []) {
      const result = normalizeEvent(event, ctx);
      expect(result.ok).toBe(true);
    }
  });
});
