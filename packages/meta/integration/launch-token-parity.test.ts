import { describe, expect, it } from 'vitest';
import { LAUNCH_TOKEN_PARAM as DOMAIN_PARAM } from '@am/domain';
import { LAUNCH_TOKEN_PARAM as META_PARAM, buildDestinationUrl } from '../src/draft';

/**
 * `@am/meta` writes the launch token into the Meta ad URL; the funnel runtime in
 * `@am/tracking` reads it back. They do not import each other, so nothing but a
 * shared constant stops them drifting — and the failure mode is silent: the
 * runtime finds no token, every lead falls back to UNKNOWN attribution, and the
 * symptom looks like weak campaigns rather than a bug.
 *
 * This test exists because that drift actually happened during integration
 * (`am_lt` vs `am_t`).
 */
describe('launch token parameter parity', () => {
  it('uses the shared contract constant, not a package-local one', () => {
    expect(META_PARAM).toBe(DOMAIN_PARAM);
    expect(DOMAIN_PARAM).toBe('am_t');
  });

  it('writes a destination URL the funnel runtime can read the token from', () => {
    const url = buildDestinationUrl({
      baseUrl: 'https://go.am-beratung.de/f/potenzialanalyse',
      launchToken: 'v1.payload.signature',
      utm: {
        source: 'facebook',
        medium: 'paid_social',
        campaign: 'potenzialanalyse-q1',
        content: null,
        term: null,
      },
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get(DOMAIN_PARAM)).toBe('v1.payload.signature');
    expect(parsed.searchParams.get('utm_source')).toBe('facebook');
    expect(parsed.searchParams.get('utm_campaign')).toBe('potenzialanalyse-q1');
  });
});
