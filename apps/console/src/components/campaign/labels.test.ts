import { describe, expect, it } from 'vitest';
import {
  assertsProviderFact,
  metaFactsConfirmed,
  PROVIDER_ASSERTING_REALITIES,
  realityDescriptor,
  REALITY,
} from './labels';
import type { CampaignReality, ProviderSyncStatus } from '@/server/campaign-port';

/**
 * The wording of a reality is the console's loudest statement about a campaign.
 * Three of the six say something only Meta can know, and saying one of those
 * without a provider confirmation is the fabricated-external-fact failure in its
 * purest form (AGENTS.md rules 1 and 3).
 */

function metaSync(overrides: Partial<ProviderSyncStatus> = {}): ProviderSyncStatus[] {
  return [
    {
      provider: 'META',
      connection: 'FIXTURE',
      health: 'AWAITING_EXTERNAL_INPUT',
      detailDe: 'Kein Meta-Zugriffstoken hinterlegt; es wird gegen Fixtures gearbeitet.',
      lastSyncedAt: null,
      failedCount: 0,
      ...overrides,
    },
  ];
}

/** Sentences that assert something about the provider's records. */
const META_CLAIMS = [
  /Bei Meta existiert/,
  /liefert bei Meta aus/,
  /Die Kampagne war live und ist pausiert/,
];

describe('reality wording', () => {
  it('marks exactly the realities that make a claim about Meta', () => {
    const all: CampaignReality[] = [
      'PREVIEW',
      'DRAFT',
      'META_DRAFT_PAUSED',
      'LIVE',
      'PAUSED',
      'ENDED',
    ];
    expect(all.filter(assertsProviderFact)).toEqual([...PROVIDER_ASSERTING_REALITIES]);
  });

  /**
   * `REALITY` is what every surface renders when it has no provider answer to
   * hand, so it has to be the safe half of the pair.
   */
  it.each([...PROVIDER_ASSERTING_REALITIES])('states %s as unconfirmed by default', (reality) => {
    const descriptor = REALITY[reality];
    expect(descriptor.labelDe).toMatch(/nicht bestätigt/);
    for (const claim of META_CLAIMS) {
      expect(descriptor.explanationDe).not.toMatch(claim);
    }
  });

  it('says what Meta confirmed only once Meta confirmed it', () => {
    const unconfirmed = realityDescriptor('META_DRAFT_PAUSED', false);
    expect(unconfirmed.labelDe).toBe('Meta-Entwurf – von Meta nicht bestätigt');
    expect(unconfirmed.explanationDe).not.toMatch(/Bei Meta existiert/);

    const confirmed = realityDescriptor('META_DRAFT_PAUSED', true);
    expect(confirmed.labelDe).toBe('Meta-Entwurf – pausiert');
    expect(confirmed.explanationDe).toMatch(/Bei Meta existiert ein Entwurf im Status PAUSED/);
  });

  /** A reality about our own records reads the same either way. */
  it('leaves the realities that claim nothing about Meta untouched', () => {
    for (const reality of ['PREVIEW', 'DRAFT', 'ENDED'] as CampaignReality[]) {
      expect(realityDescriptor(reality, false)).toEqual(realityDescriptor(reality, true));
    }
  });
});

describe('metaFactsConfirmed', () => {
  /**
   * This is the contradiction the header used to produce: it claimed a paused
   * draft existed at Meta while the provider-sync panel beside it reported that
   * no access token is configured.
   */
  it('is false while the campaign runs against fixtures', () => {
    expect(metaFactsConfirmed(metaSync())).toBe(false);
    expect(metaFactsConfirmed(metaSync({ health: 'PASS' }))).toBe(false);
    expect(metaFactsConfirmed(metaSync({ connection: 'NOT_CONFIGURED' }))).toBe(false);
  });

  it('is false when the connection exists but its picture is unreliable', () => {
    expect(metaFactsConfirmed(metaSync({ connection: 'CONNECTED', health: 'FAIL' }))).toBe(false);
    expect(
      metaFactsConfirmed(metaSync({ connection: 'CONNECTED', health: 'AWAITING_EXTERNAL_INPUT' })),
    ).toBe(false);
    expect(metaFactsConfirmed(metaSync({ connection: 'DEGRADED', health: 'PASS' }))).toBe(false);
  });

  it('is false when no Meta provider is reported at all', () => {
    expect(metaFactsConfirmed([])).toBe(false);
  });

  it('is true only for a healthy, actually connected account', () => {
    expect(metaFactsConfirmed(metaSync({ connection: 'CONNECTED', health: 'PASS' }))).toBe(true);
  });
});
