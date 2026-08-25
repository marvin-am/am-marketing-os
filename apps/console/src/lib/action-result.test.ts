import { describe, expect, it } from 'vitest';
import { DomainError, dryRun } from '@am/domain';
import { actionDryRun, actionOk, isDryRun, isOk, toActionError } from './action-result';

describe('action results', () => {
  it('keeps a dry run distinct from a success', () => {
    const result = actionDryRun(dryRun('META', 'pauseEntity', { id: '123' }));
    expect(isDryRun(result)).toBe(true);
    expect(isOk(result)).toBe(false);
  });

  it('carries data on success', () => {
    const result = actionOk({ id: 'abc' });
    expect(isOk(result)).toBe(true);
    expect(result.status === 'ok' && result.data.id).toBe('abc');
  });
});

describe('toActionError', () => {
  it('surfaces a domain error verbatim in German', () => {
    const result = toActionError(new DomainError('BUDGET_LIMIT_EXCEEDED'));
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.code).toBe('BUDGET_LIMIT_EXCEEDED');
    expect(result.messageDe).toMatch(/Rollenlimit/);
    expect(result.retryable).toBe(false);
  });

  it('marks provider failures retryable', () => {
    const result = toActionError(new DomainError('PROVIDER_RATE_LIMITED'));
    expect(result.status === 'error' && result.retryable).toBe(true);
  });

  it('extracts field errors for form rendering', () => {
    const result = toActionError(
      new DomainError('VALIDATION_FAILED', {
        details: { fieldErrors: { postcode: 'Bitte fünf Ziffern angeben.', junk: 42 } },
      }),
    );
    if (result.status !== 'error') return expect.unreachable();
    expect(result.fieldErrors).toEqual({ postcode: 'Bitte fünf Ziffern angeben.' });
  });

  it('never leaks an unknown error to the screen but still says something German', () => {
    const result = toActionError(new Error('connection reset by peer at 10.0.0.4:5432'));
    if (result.status !== 'error') return expect.unreachable();
    expect(result.code).toBe('INTERNAL');
    expect(result.messageDe).not.toContain('10.0.0.4');
    expect(result.messageDe).toMatch(/Fehler/);
    expect(result.retryable).toBe(true);
  });

  it('handles a thrown non-error value', () => {
    const result = toActionError('boom');
    expect(result.status === 'error' && result.code).toBe('INTERNAL');
  });
});
