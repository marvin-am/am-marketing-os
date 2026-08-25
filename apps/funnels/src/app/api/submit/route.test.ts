import { beforeEach, describe, expect, it } from 'vitest';

process.env.LOG_LEVEL = 'error';

import { NextRequest } from 'next/server';
import { resetRateLimiters } from '@/server/rate-limit';
import { resetPublishedCache } from '@/server/published';
import { resetFunnelStore } from '@/server/store';
import { POST } from './route';

/**
 * The submit endpoint as it is actually reachable.
 *
 * This is the one route that writes personal data and queues outbox rows, so its
 * budget has to hold against a caller that controls every part of the request.
 * It did not: the rate-limit key was built from the visitor id, a cookie-less
 * request has one minted for it on arrival, and so dropping `am_vid` bought a
 * full budget per request — unbounded lead injection from a single address.
 *
 * The bodies below are deliberately unusable. The limit is applied before the
 * request is parsed, which is the point: a caller must not be able to spend the
 * expensive part of this route to find out whether it is over its budget.
 */

const HUMAN_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const VISITOR_ID = 'e1e2e3e4-0000-4000-8000-00000000000a';

/** Ten submissions of burst, refilling at one every six minutes. */
const ATTEMPTS = 16;

function submit(options: { address: string; cookie?: string }): NextRequest {
  const headers = new Headers({
    origin: 'https://funnel.example.com',
    host: 'funnel.example.com',
    'content-type': 'application/json',
    'user-agent': HUMAN_UA,
    'accept-language': 'de-DE',
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': `${options.address}, 198.51.100.200`,
  });
  if (options.cookie) headers.set('cookie', options.cookie);

  return new NextRequest('https://funnel.example.com/api/submit', {
    method: 'POST',
    headers,
    body: '{}',
  });
}

async function burst(next: () => NextRequest, count = ATTEMPTS): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < count; index += 1) {
    statuses.push((await POST(next())).status);
  }
  return statuses;
}

const notLimited = (statuses: readonly number[]): number =>
  statuses.filter((status) => status !== 429).length;

beforeEach(() => {
  resetFunnelStore();
  resetPublishedCache();
  resetRateLimiters();
});

describe('POST /api/submit', () => {
  it('rate-limits a burst that sends no cookie at all', async () => {
    const statuses = await burst(() => submit({ address: '203.0.113.7' }));

    expect(statuses).toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });

  it('gives a caller no more attempts without a cookie than with one', async () => {
    const withCookie = await burst(() =>
      submit({ address: '203.0.113.7', cookie: `am_vid=${VISITOR_ID}` }),
    );
    resetRateLimiters();
    const withoutCookie = await burst(() => submit({ address: '203.0.113.7' }));

    expect(notLimited(withCookie)).toBeGreaterThan(0);
    expect(notLimited(withoutCookie)).toBeLessThanOrEqual(notLimited(withCookie));
  });

  it('answers a refusal with Retry-After rather than a silent drop', async () => {
    await burst(() => submit({ address: '203.0.113.7' }));

    const refused = await POST(submit({ address: '203.0.113.7' }));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('spends only the budget of the address the request came from', async () => {
    await burst(() => submit({ address: '203.0.113.7' }));

    const elsewhere = await POST(submit({ address: '198.51.100.4' }));
    expect(elsewhere.status).not.toBe(429);
  });
});
