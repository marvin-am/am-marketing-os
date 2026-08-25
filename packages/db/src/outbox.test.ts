import { describe, expect, it } from 'vitest';
import { RETRY_POLICY, capiEventIdSource, initialLeadEventIdSource } from '@am/domain';
import { outboxPayloadHash, planRetry } from './outbox';
import { foldOutboxStats } from './repositories/outbox';
import type { OutboxEventRow } from './types';

const event = (overrides: Partial<Pick<OutboxEventRow, 'event_id' | 'attempt_count'>> = {}) => ({
  event_id: 'lead:11111111-1111-4111-8111-111111111111',
  attempt_count: 1,
  ...overrides,
});

describe('outbox retry planning', () => {
  it('schedules the first retry inside the base delay window', () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    const decision = planRetry(event({ attempt_count: 1 }), now);

    expect(decision.status).toBe('FAILED_RETRYING');
    expect(decision.delayMs).not.toBeNull();
    // Base delay ± the 20 % deterministic jitter.
    expect(decision.delayMs!).toBeGreaterThanOrEqual(RETRY_POLICY.baseDelayMs * 0.8);
    expect(decision.delayMs!).toBeLessThanOrEqual(RETRY_POLICY.baseDelayMs * 1.2);
    expect(new Date(decision.nextAttemptAt!).getTime()).toBe(now.getTime() + decision.delayMs!);
  });

  it('backs off exponentially', () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    const delays = [1, 2, 3, 4, 5].map((attempt) => planRetry(event({ attempt_count: attempt }), now).delayMs!);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
    expect(delays.at(-1)!).toBeLessThanOrEqual(RETRY_POLICY.maxDelayMs * 1.2);
  });

  it('is deterministic: a replay of the same event schedules identically', () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    const a = planRetry(event({ attempt_count: 3 }), now);
    const b = planRetry(event({ attempt_count: 3 }), now);
    expect(a).toEqual(b);
  });

  it('jitters differently for different event ids, so retries do not stampede', () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    const a = planRetry({ event_id: 'lead:a', attempt_count: 4 }, now).delayMs;
    const b = planRetry({ event_id: 'lead:b', attempt_count: 4 }, now).delayMs;
    expect(a).not.toBe(b);
  });

  it('dead-letters once the attempt budget is exhausted', () => {
    const decision = planRetry(event({ attempt_count: RETRY_POLICY.maxAttempts }), new Date());
    expect(decision.status).toBe('DEAD_LETTER');
    expect(decision.nextAttemptAt).toBeNull();
    expect(decision.delayMs).toBeNull();
  });

  it('does not dead-letter one attempt early', () => {
    const decision = planRetry(event({ attempt_count: RETRY_POLICY.maxAttempts - 1 }), new Date());
    expect(decision.status).toBe('FAILED_RETRYING');
  });
});

describe('outbox dedup keys', () => {
  it('hashes payloads order-independently', () => {
    const a = outboxPayloadHash({ email: '[redacted]', size: 42, nested: { b: 1, a: 2 } });
    const b = outboxPayloadHash({ nested: { a: 2, b: 1 }, size: 42, email: '[redacted]' });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('changes when the payload changes', () => {
    expect(outboxPayloadHash({ a: 1 })).not.toBe(outboxPayloadHash({ a: 2 }));
  });

  it('derives one shared id for the browser pixel and the server CAPI lead', () => {
    const submissionId = '11111111-1111-4111-8111-111111111111';
    expect(initialLeadEventIdSource(submissionId)).toBe(`lead:${submissionId}`);
  });

  it('derives a stable down-funnel id per transition version', () => {
    const a = capiEventIdSource('form-1', 'VQ_SCHEDULED', 1);
    const b = capiEventIdSource('form-1', 'VQ_SCHEDULED', 1);
    const c = capiEventIdSource('form-1', 'VQ_SCHEDULED', 2);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('outbox stats', () => {
  it('folds every state into the console summary', () => {
    const stats = foldOutboxStats([
      { status: 'PENDING' },
      { status: 'PENDING' },
      { status: 'PROCESSING' },
      { status: 'SENT' },
      { status: 'ACCEPTED' },
      { status: 'ACCEPTED' },
      { status: 'FAILED_RETRYING' },
      { status: 'DEAD_LETTER' },
      { status: 'EXPIRED' },
    ]);
    expect(stats).toEqual({
      pending: 2,
      processing: 1,
      sent: 1,
      accepted: 2,
      failedRetrying: 1,
      deadLetter: 1,
      expired: 1,
    });
  });
});
