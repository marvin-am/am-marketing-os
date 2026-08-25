import { describe, expect, it } from 'vitest';
import { analyzeFunnel, type FunnelAnalysisEvent } from './funnel-analysis';

function event(
  overrides: Partial<FunnelAnalysisEvent> & Pick<FunnelAnalysisEvent, 'event_type' | 'session_id'>,
): FunnelAnalysisEvent {
  return {
    occurred_at: '2026-03-01T10:00:00.000Z',
    traffic_kind: 'PRODUCTION',
    ...overrides,
  };
}

/**
 * A three-step form: 100 sessions view the funnel, 60 start, step 2 is the
 * bottleneck, 20 submit.
 */
function buildEvents(): FunnelAnalysisEvent[] {
  const events: FunnelAnalysisEvent[] = [];
  for (let i = 0; i < 100; i++) events.push(event({ event_type: 'funnel_viewed', session_id: `s${i}` }));
  for (let i = 0; i < 60; i++) {
    events.push(event({ event_type: 'form_started', session_id: `s${i}` }));
    events.push(event({ event_type: 'form_step_viewed', session_id: `s${i}`, step_id: 'step_one', occurred_at: '2026-03-01T10:01:00.000Z' }));
  }
  // 50 of 60 complete step one.
  for (let i = 0; i < 50; i++) {
    events.push(event({ event_type: 'form_step_completed', session_id: `s${i}`, step_id: 'step_one' }));
    events.push(event({ event_type: 'form_step_viewed', session_id: `s${i}`, step_id: 'step_two', occurred_at: '2026-03-01T10:02:00.000Z' }));
  }
  // 25 of 50 complete step two — the bottleneck.
  for (let i = 0; i < 25; i++) {
    events.push(event({ event_type: 'form_step_completed', session_id: `s${i}`, step_id: 'step_two' }));
    events.push(event({ event_type: 'form_step_viewed', session_id: `s${i}`, step_id: 'step_three', occurred_at: '2026-03-01T10:03:00.000Z' }));
  }
  for (let i = 0; i < 20; i++) {
    events.push(event({ event_type: 'form_step_completed', session_id: `s${i}`, step_id: 'step_three' }));
    events.push(event({ event_type: 'lead_submitted', session_id: `s${i}`, submission_id: `sub${i}` }));
  }
  // Validation failures concentrated on step two's postcode field.
  for (let i = 25; i < 45; i++) {
    events.push(
      event({
        event_type: 'form_validation_failed',
        session_id: `s${i}`,
        step_id: 'step_two',
        field_id: 'plz',
        error_code: 'INVALID_POSTCODE',
      }),
    );
  }
  for (let i = 25; i < 30; i++) {
    events.push(
      event({
        event_type: 'form_validation_failed',
        session_id: `s${i}`,
        step_id: 'step_two',
        field_id: 'mitarbeiter',
        error_code: 'REQUIRED',
      }),
    );
  }
  return events;
}

describe('analyzeFunnel — top-level rates', () => {
  const analysis = analyzeFunnel({ events: buildEvents() });

  it('counts distinct sessions at each stage', () => {
    expect(analysis.funnelSessions).toBe(100);
    expect(analysis.formStarts).toBe(60);
    expect(analysis.submissions).toBe(20);
  });

  it('reports rates with their numerator and denominator', () => {
    expect(analysis.formStartRate).toEqual({ numerator: 60, denominator: 100, value: 0.6 });
    expect(analysis.submissionRate).toEqual({ numerator: 20, denominator: 100, value: 0.2 });
    expect(analysis.formCompletionRate).toEqual({
      numerator: 20,
      denominator: 60,
      value: 20 / 60,
    });
  });

  it('returns null rates rather than 0 on an empty funnel', () => {
    const empty = analyzeFunnel({ events: [] });
    expect(empty.formStartRate.value).toBeNull();
    expect(empty.submissionRate.value).toBeNull();
    expect(empty.steps).toEqual([]);
    expect(empty.worstStepKey).toBeNull();
  });
});

describe('analyzeFunnel — per-step drop-off', () => {
  const analysis = analyzeFunnel({ events: buildEvents() });

  it('computes viewed, completed and the drop-off rate for each step', () => {
    expect(analysis.steps.map((s) => [s.stepKey, s.viewed, s.completed])).toEqual([
      ['step_one', 60, 50],
      ['step_two', 50, 25],
      ['step_three', 25, 20],
    ]);
    expect(analysis.steps[1].dropOffRate).toEqual({ numerator: 25, denominator: 50, value: 0.5 });
    expect(analysis.steps[1].completionRate).toEqual({ numerator: 25, denominator: 50, value: 0.5 });
  });

  it('identifies the step that loses the most people', () => {
    expect(analysis.worstStepKey).toBe('step_two');
    expect(analysis.steps[1].lostSessions).toBe(25);
  });

  it('derives the step order from first appearance when none is declared', () => {
    expect(analysis.steps.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(analysis.steps.map((s) => s.stepKey)).toEqual(['step_one', 'step_two', 'step_three']);
  });

  it('honours a declared step order and labels', () => {
    const declared = analyzeFunnel({
      events: buildEvents(),
      steps: [
        { key: 'step_three', label: 'Kontaktdaten' },
        { key: 'step_one', label: 'Einstieg' },
        { key: 'step_two', label: 'Qualifizierung' },
      ],
    });
    expect(declared.steps.map((s) => s.stepKey)).toEqual(['step_three', 'step_one', 'step_two']);
    expect(declared.steps[2].label).toBe('Qualifizierung');
  });
});

describe('analyzeFunnel — validation failures', () => {
  const analysis = analyzeFunnel({ events: buildEvents() });

  it('breaks failures down by field and error code, worst first', () => {
    const step2 = analysis.steps.find((s) => s.stepKey === 'step_two');
    expect(step2?.validationFailures).toEqual([
      {
        fieldId: 'plz',
        errorCode: 'INVALID_POSTCODE',
        count: 20,
        messageDe: 'Bitte geben Sie eine gültige fünfstellige Postleitzahl ein.',
      },
      {
        fieldId: 'mitarbeiter',
        errorCode: 'REQUIRED',
        count: 5,
        messageDe: 'Bitte füllen Sie dieses Feld aus.',
      },
    ]);
    expect(step2?.validationFailureCount).toBe(25);
  });

  it('counts distinct sessions that hit a validation error', () => {
    const step2 = analysis.steps.find((s) => s.stepKey === 'step_two');
    expect(step2?.sessionsWithValidationFailure).toBe(20);
  });

  it('ranks failures across the whole form', () => {
    expect(analysis.topValidationFailures[0]).toMatchObject({ fieldId: 'plz', count: 20 });
  });

  it('carries the German message the visitor actually saw', () => {
    for (const failure of analysis.topValidationFailures) {
      expect(failure.messageDe.length).toBeGreaterThan(5);
    }
  });
});

describe('analyzeFunnel — traffic filtering', () => {
  it('excludes BOT, PREVIEW, INTERNAL and TEST traffic and reports the volume', () => {
    const events: FunnelAnalysisEvent[] = [
      event({ event_type: 'funnel_viewed', session_id: 'real' }),
      event({ event_type: 'funnel_viewed', session_id: 'bot', traffic_kind: 'BOT' }),
      event({ event_type: 'funnel_viewed', session_id: 'preview', traffic_kind: 'PREVIEW' }),
      event({ event_type: 'funnel_viewed', session_id: 'internal', traffic_kind: 'INTERNAL' }),
      event({ event_type: 'funnel_viewed', session_id: 'qa', traffic_kind: 'TEST' }),
      event({ event_type: 'form_step_viewed', session_id: 'bot', step_id: 'step_one', traffic_kind: 'BOT' }),
    ];
    const analysis = analyzeFunnel({ events });
    expect(analysis.funnelSessions).toBe(1);
    expect(analysis.steps).toEqual([]);
    expect(analysis.excludedEvents).toBe(5);
    expect(analysis.excludedByTrafficKind).toEqual({ BOT: 2, PREVIEW: 1, INTERNAL: 1, TEST: 1 });
  });
});

describe('analyzeFunnel — determinism', () => {
  it('produces identical output for identical input', () => {
    const events = buildEvents();
    expect(analyzeFunnel({ events })).toEqual(analyzeFunnel({ events }));
  });

  it('ignores step events without a step id instead of inventing a bucket', () => {
    const analysis = analyzeFunnel({
      events: [
        event({ event_type: 'form_step_viewed', session_id: 's1' }),
        event({ event_type: 'form_step_completed', session_id: 's1' }),
      ],
    });
    expect(analysis.steps).toEqual([]);
  });

  it('ignores validation failures missing a field or error code', () => {
    const analysis = analyzeFunnel({
      events: [
        event({ event_type: 'form_step_viewed', session_id: 's1', step_id: 'step_one' }),
        event({ event_type: 'form_validation_failed', session_id: 's1', step_id: 'step_one', field_id: 'plz' }),
      ],
    });
    expect(analysis.steps[0].validationFailures).toEqual([]);
  });
});
