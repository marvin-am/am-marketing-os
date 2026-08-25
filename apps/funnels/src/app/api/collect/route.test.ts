import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.LOG_LEVEL = 'error';

import { NextRequest } from 'next/server';
import { MINTED_VISITOR_HEADER } from '@am/tracking';
import { resetRateLimiters } from '@/server/rate-limit';
import { resetFunnelStore } from '@/server/store';
import { POST } from './route';

/**
 * The collector as it is actually reachable: over HTTP, with whatever headers
 * the caller feels like sending.
 *
 * What these pin is that the budget belongs to the address a request comes from
 * and not to the cookie it carries. The rate-limit key used to be built from the
 * visitor id first, and because a request without `am_vid` has one minted for it
 * on arrival, every cookie-less request turned up with an empty bucket of its
 * own — an unbounded event and outbox write endpoint for anyone willing to drop
 * a cookie.
 */

const HUMAN_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const VISITOR_ID = 'd1d2d3d4-0000-4000-8000-00000000000a';
const FORM_INSTANCE_ID = 'd1d2d3d4-0000-4000-8000-00000000000b';

/** The collector allows 60 events of burst; a run has to outlast that. */
const BATCH_SIZE = 6;
const BATCHES = 20;

/** The proxy hop every request shares, appended to the right of the client. */
const PROXY_ADDRESS = '198.51.100.200';

function events(count: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({
    event_type: 'form_step_viewed',
    event_schema_version: 1,
    occurred_at: '2026-08-25T10:00:00.000Z',
    visitor_id: VISITOR_ID,
    session_id: VISITOR_ID,
    step_id: `frage_${index + 1}`,
    form_instance_id: FORM_INSTANCE_ID,
    metadata: { step_index: index + 1 },
  }));
}

function collect(options: { address: string; cookie?: string; minted?: boolean }): NextRequest {
  const headers = new Headers({
    origin: 'https://funnel.example.com',
    host: 'funnel.example.com',
    'content-type': 'application/json',
    'user-agent': HUMAN_UA,
    'accept-language': 'de-DE',
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': `${options.address}, ${PROXY_ADDRESS}`,
  });
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.minted) headers.set(MINTED_VISITOR_HEADER, '1');

  return new NextRequest('https://funnel.example.com/api/collect', {
    method: 'POST',
    headers,
    body: JSON.stringify({ events: events(BATCH_SIZE) }),
  });
}

async function burst(next: () => NextRequest, count = BATCHES): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < count; index += 1) {
    statuses.push((await POST(next())).status);
  }
  return statuses;
}

const accepted = (statuses: readonly number[]): number =>
  statuses.filter((status) => status === 200).length;

beforeEach(() => {
  resetFunnelStore();
  resetRateLimiters();
});

describe('POST /api/collect', () => {
  it('rate-limits a burst that sends no cookie at all', async () => {
    const statuses = await burst(() => collect({ address: '203.0.113.7' }));
    expect(statuses).toContain(429);
  });

  it('rate-limits a burst carrying the cookie the edge just minted for it', async () => {
    /* What a cookie-less caller actually looks like in production: the edge
       issues identity before the route runs and forwards it, so every request
       arrives with an `am_vid` — a different one each time. */
    const statuses = await burst(() =>
      collect({ address: '203.0.113.7', cookie: `am_vid=${randomUUID()}`, minted: true }),
    );

    expect(statuses).toContain(429);
  });

  it('gives a caller no more budget without a cookie than with one', async () => {
    const withCookie = await burst(() =>
      collect({ address: '203.0.113.7', cookie: `am_vid=${VISITOR_ID}` }),
    );
    resetRateLimiters();
    const withoutCookie = await burst(() => collect({ address: '203.0.113.7' }));

    expect(accepted(withCookie)).toBeGreaterThan(0);
    expect(accepted(withoutCookie)).toBeLessThanOrEqual(accepted(withCookie));
  });

  it('spends only the budget of the address the request came from', async () => {
    /* Both bursts arrive through the same proxy hop, so a key read from
       anything but the first `x-forwarded-for` entry would put every caller
       behind that proxy — in production, every caller at all — into one bucket. */
    const flooded = await burst(() => collect({ address: '203.0.113.7' }));
    expect(flooded).toContain(429);

    const elsewhere = await POST(collect({ address: '198.51.100.4' }));
    expect(elsewhere.status).toBe(200);
  });
});
