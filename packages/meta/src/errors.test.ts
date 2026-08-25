import { describe, expect, it } from 'vitest';
import { DomainError } from '@am/domain';
import {
  isBusinessUseCaseRateLimitCode,
  isRateLimited,
  mapMetaError,
  mapMetaTransportError,
  parseMetaErrorBody,
  retryAfterFromHeaders,
  retryAfterMsOf,
} from './errors';
import { DEFAULT_META_RETRY, withRateLimitRetry } from './retry';

function metaError(code: number, subcode?: number, message = 'Meta says no') {
  return {
    error: {
      message,
      type: 'OAuthException',
      code,
      error_subcode: subcode,
      fbtrace_id: 'AbCdEf123',
    },
  };
}

const context = { operation: 'meta.test' };

/* -------------------------------------------------------------------------- */

describe('Meta error mapping', () => {
  it('maps throttling codes onto PROVIDER_RATE_LIMITED', () => {
    for (const code of [4, 17, 32, 613]) {
      const error = mapMetaError(400, metaError(code), context);
      expect(error.code).toBe('PROVIDER_RATE_LIMITED');
      expect(error.retryable).toBe(true);
      expect(error.messageDe).toContain('Anfragelimit');
      expect(isRateLimited(error)).toBe(true);
    }
  });

  it('maps business-use-case rate limits (80000 range)', () => {
    expect(isBusinessUseCaseRateLimitCode(80004)).toBe(true);
    expect(isBusinessUseCaseRateLimitCode(79999)).toBe(false);
    expect(mapMetaError(400, metaError(80004), context).code).toBe('PROVIDER_RATE_LIMITED');
  });

  it('maps HTTP 429 even without a recognised code', () => {
    expect(mapMetaError(429, {}, context).code).toBe('PROVIDER_RATE_LIMITED');
  });

  it('maps an expired token onto a re-authorisation instruction', () => {
    const error = mapMetaError(400, metaError(190, 463), context);
    expect(error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(error.retryable).toBe(false);
    expect(error.messageDe).toContain('abgelaufen');
    expect(error.messageDe).toContain('neu autorisieren');
    expect(error.details.meta_subcode).toBe(463);
  });

  it('maps a permission error onto a clear German message', () => {
    const error = mapMetaError(400, metaError(200), context);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.retryable).toBe(false);
    expect(error.messageDe).toContain('Berechtigungen');
    expect(error.messageDe).toMatch(/^Meta hat den Zugriff verweigert/);
  });

  it('maps an invalid parameter onto VALIDATION_FAILED and a 5xx onto a retryable error', () => {
    expect(mapMetaError(400, metaError(100), context).code).toBe('VALIDATION_FAILED');
    const serverError = mapMetaError(500, metaError(2), context);
    expect(serverError.code).toBe('PROVIDER_ERROR');
    expect(serverError.retryable).toBe(true);
  });

  it('keeps the English developer message out of the German surface', () => {
    const error = mapMetaError(400, metaError(200, undefined, 'Permissions error'), context);
    expect(error.messageDe).not.toContain('Permissions error');
    expect(error.details.meta_message).toBe('Permissions error');
    expect(error.details.fbtrace_id).toBe('AbCdEf123');
  });

  it('survives an unparseable body', () => {
    const info = parseMetaErrorBody(502, '<html>Bad Gateway</html>');
    expect(info.code).toBeNull();
    expect(info.message).toContain('Bad Gateway');
    expect(mapMetaError(502, '<html>', context).code).toBe('PROVIDER_ERROR');
  });

  it('wraps a transport failure as retryable', () => {
    const error = mapMetaTransportError(new Error('ECONNRESET'), 'meta.test');
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.details.reason).toBe('ECONNRESET');
  });
});

/* -------------------------------------------------------------------------- */

describe('rate-limit hints', () => {
  function headers(entries: Record<string, string>) {
    return { get: (name: string) => entries[name.toLowerCase()] ?? null };
  }

  it('reads Retry-After in seconds', () => {
    expect(retryAfterFromHeaders(headers({ 'retry-after': '30' }))).toBe(30_000);
  });

  it('reads estimated_time_to_regain_access in minutes', () => {
    const buc = JSON.stringify({
      '1094732810554371': [
        { type: 'ads_management', call_count: 100, estimated_time_to_regain_access: 4 },
      ],
    });
    expect(retryAfterFromHeaders(headers({ 'x-business-use-case-usage': buc }))).toBe(240_000);
  });

  it('takes the longest concrete hint', () => {
    const buc = JSON.stringify({ b: [{ estimated_time_to_regain_access: 1 }] });
    expect(
      retryAfterFromHeaders(headers({ 'retry-after': '120', 'x-business-use-case-usage': buc })),
    ).toBe(120_000);
  });

  it('returns null for missing or malformed hints', () => {
    expect(retryAfterFromHeaders(null)).toBeNull();
    expect(retryAfterFromHeaders(headers({}))).toBeNull();
    expect(retryAfterFromHeaders(headers({ 'x-business-use-case-usage': 'not json' }))).toBeNull();
  });

  it('surfaces the hint on the mapped error', () => {
    const error = mapMetaError(429, metaError(17), {
      operation: 'meta.test',
      headers: headers({ 'retry-after': '5' }),
    });
    expect(retryAfterMsOf(error)).toBe(5_000);
  });
});

/* -------------------------------------------------------------------------- */

describe('withRateLimitRetry', () => {
  const slept: number[] = [];
  const config = {
    ...DEFAULT_META_RETRY,
    maxAttempts: 4,
    // Above the 1 s floor `nextRetryDelayMs` applies, so growth is observable.
    baseDelayMs: 2_000,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };

  it('backs off and eventually succeeds', async () => {
    slept.length = 0;
    let attempts = 0;
    const outcome = await withRateLimitRetry(
      'meta.test.backoff',
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new DomainError('PROVIDER_RATE_LIMITED', { retryable: true });
        }
        return 'ok';
      },
      config,
    );

    expect(outcome.value).toBe('ok');
    expect(outcome.attempts).toBe(3);
    expect(outcome.delaysMs).toHaveLength(2);
    expect(outcome.delaysMs.every((delay) => delay > 0)).toBe(true);
    // Exponential: the second wait is longer than the first.
    expect(outcome.delaysMs[1]).toBeGreaterThan(outcome.delaysMs[0]);
    expect(slept).toEqual(outcome.delaysMs);
  });

  it('prefers Meta’s explicit Retry-After hint over the computed backoff', async () => {
    slept.length = 0;
    let attempts = 0;
    await withRateLimitRetry(
      'meta.test.hinted',
      async () => {
        attempts++;
        if (attempts === 1) {
          throw mapMetaError(429, metaError(17), {
            operation: 'meta.test',
            headers: { get: (name: string) => (name === 'retry-after' ? '7' : null) },
          });
        }
        return 'ok';
      },
      config,
    );
    expect(slept).toEqual([7_000]);
  });

  it('does not retry a non-retryable error', async () => {
    slept.length = 0;
    let attempts = 0;
    await expect(
      withRateLimitRetry(
        'meta.test.permission',
        async () => {
          attempts++;
          throw mapMetaError(400, metaError(200), context);
        },
        config,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
  });

  it('gives up after maxAttempts and reports the applied delays', async () => {
    slept.length = 0;
    let thrown: unknown;
    try {
      await withRateLimitRetry(
        'meta.test.exhausted',
        async () => {
          throw new DomainError('PROVIDER_RATE_LIMITED', { retryable: true });
        },
        config,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe('PROVIDER_RATE_LIMITED');
    expect((thrown as DomainError).details.attempts).toBe(4);
    expect(slept).toHaveLength(3);
  });
});
