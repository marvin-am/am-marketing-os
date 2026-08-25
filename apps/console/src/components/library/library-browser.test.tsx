import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LibrarySnapshot } from '@/server/ops-port';
import { LibraryBrowser } from './library-browser';
import { EMPTY_LIBRARY_FILTERS, filterLibrary } from './library-search';

const SNAPSHOT: LibrarySnapshot = {
  generatedAt: '2026-08-25T07:30:00.000Z',
  creatives: [
    {
      id: 'creative-1',
      nameDe: 'Konkretes Ergebnis',
      principle: 'CONCRETE_RESULT',
      angleNameDe: 'Kostendruck im Bestand',
      offerNameDe: 'Potenzialanalyse',
      reviewState: 'APPROVED',
      hookDe: '38 % weniger Heizkosten',
      bodyDe: 'Gerechnet, nicht geschätzt.',
      renditions: [
        { aspectRatio: '1:1', width: 1080, height: 1080, status: 'READY', altTextDe: 'Alt' },
        { aspectRatio: '4:5', width: 1080, height: 1350, status: 'PENDING', altTextDe: null },
      ],
      performance: {
        spendMinor: 189_000,
        currency: 'EUR',
        impressions: 71_004,
        leads: 41,
        costPerLeadMinor: 4_610,
        maturity: 'MATURE',
        attributionLevel: 'REVENUE_LINKED',
      },
      claims: [],
      href: '/library/creatives/creative-1',
    },
    {
      id: 'creative-2',
      nameDe: 'Einwandbehandlung Förderung',
      principle: 'OBJECTION_HANDLING',
      angleNameDe: 'Förderung sicher mitnehmen',
      offerNameDe: 'Potenzialanalyse',
      reviewState: 'DRAFT',
      hookDe: 'Keine Zeit für Bürokratie?',
      bodyDe: 'Wir übernehmen den Antrag.',
      renditions: [],
      performance: {
        spendMinor: 0,
        currency: 'EUR',
        impressions: 0,
        leads: 0,
        costPerLeadMinor: null,
        maturity: 'IMMATURE',
        attributionLevel: 'CREATIVE_ONLY',
      },
      claims: [],
      href: '/library/creatives/creative-2',
    },
  ],
  angles: [
    {
      id: 'angle-1',
      nameDe: 'Kostendruck im Bestand',
      coreMessageDe: 'Energiekosten planbar senken.',
      audienceDe: 'Eigentümer',
      versions: [
        { version: 1, status: 'PUBLISHED', summaryDe: 'Erstfassung.', publishedAt: null },
      ],
      usedInCampaigns: 2,
      href: '/library/angles/angle-1',
    },
  ],
  offers: [
    {
      id: 'offer-1',
      nameDe: 'Potenzialanalyse',
      type: 'POTENTIAL_ANALYSIS',
      promiseDe: 'Drei Maßnahmen in 20 Minuten.',
      effortPromiseDe: '20 Minuten',
      usedInCampaigns: 3,
      href: '/library/offers/offer-1',
    },
  ],
  claims: [
    {
      id: 'claim-backed',
      textDe: '38 % weniger Heizkosten nach Umsetzung.',
      confidence: 'FACT',
      evidence: {
        kindDe: 'Case Study',
        summaryDe: 'Auswertung von 14 Projekten.',
        sourceRefDe: 'case-study/muster-bau',
        approved: true,
      },
      requiresHypothesisLabel: false,
    },
    {
      id: 'claim-unbacked',
      textDe: 'Handwerksbetriebe gewinnen schneller Aufträge.',
      confidence: 'HYPOTHESIS',
      evidence: null,
      requiresHypothesisLabel: true,
    },
  ],
  caseStudies: [],
  testimonials: [],
  faqs: [],
  guardrails: [
    {
      id: 'guardrail-1',
      kindDe: 'Verbotene Aussage',
      pattern: 'Förderung sicher',
      reasonDe: 'Förderzusagen liegen bei der Bewilligungsstelle.',
      severity: 'BLOCK',
    },
  ],
  historicalCampaigns: [
    {
      id: 'hist-1',
      nameDe: 'Q2 Bestandshalter',
      periodDe: '01.04.2026 – 30.06.2026',
      spendMinor: 1_284_000,
      currency: 'EUR',
      attributionLevel: 'REVENUE_LINKED',
      attributionCoverage: 0.91,
      maturity: 'MATURE',
      confidence: 'FACT',
      outcomeDe: '187 Leads, 11 Abschlüsse.',
      angleNameDe: 'Kostendruck im Bestand',
      offerNameDe: 'Potenzialanalyse',
      href: '/kampagnen/hist-1',
    },
  ],
};

describe('filterLibrary', () => {
  it('searches across every area, not only the visible tab', () => {
    const result = filterLibrary(SNAPSHOT, { ...EMPTY_LIBRARY_FILTERS, query: 'Förderung' });

    expect(result.creatives.map((c) => c.id)).toEqual(['creative-2']);
    expect(result.guardrails.map((g) => g.id)).toEqual(['guardrail-1']);
    expect(result.angles).toHaveLength(0);
  });

  it('filters creatives by principle, angle, offer and performance', () => {
    expect(
      filterLibrary(SNAPSHOT, { ...EMPTY_LIBRARY_FILTERS, principle: 'CONCRETE_RESULT' }).creatives,
    ).toHaveLength(1);
    expect(
      filterLibrary(SNAPSHOT, { ...EMPTY_LIBRARY_FILTERS, angle: 'Förderung sicher mitnehmen' })
        .creatives[0]?.id,
    ).toBe('creative-2');
    expect(
      filterLibrary(SNAPSHOT, { ...EMPTY_LIBRARY_FILTERS, offer: 'Potenzialanalyse' }).creatives,
    ).toHaveLength(2);
    expect(
      filterLibrary(SNAPSHOT, { ...EMPTY_LIBRARY_FILTERS, performance: 'NO_LEADS' }).creatives[0]
        ?.id,
    ).toBe('creative-2');
    expect(
      filterLibrary(SNAPSHOT, { ...EMPTY_LIBRARY_FILTERS, performance: 'MATURE' }).creatives[0]?.id,
    ).toBe('creative-1');
  });

  it('requires every search term to match', () => {
    expect(
      filterLibrary(SNAPSHOT, { ...EMPTY_LIBRARY_FILTERS, query: 'Heizkosten Bürokratie' })
        .counts.creatives,
    ).toBe(0);
  });
});

describe('LibraryBrowser', () => {
  it('renders creatives with their renditions and data maturity', () => {
    render(<LibraryBrowser snapshot={SNAPSHOT} />);

    expect(screen.getByRole('link', { name: 'Konkretes Ergebnis' })).toBeInTheDocument();
    expect(screen.getByText(/1:1 · 1080×1080 · fertig/)).toBeInTheDocument();
    expect(screen.getByText(/4:5 · 1080×1350 · in Arbeit/)).toBeInTheDocument();
    expect(screen.getAllByText('Reif').length).toBeGreaterThan(0);
  });

  it('labels an unbacked claim as a hypothesis instead of hiding it', () => {
    render(<LibraryBrowser snapshot={SNAPSHOT} defaultTab="claims" />);

    const unbacked = document.querySelector('[data-claim="claim-unbacked"]');
    expect(unbacked).not.toBeNull();
    expect(unbacked?.textContent).toContain('Hypothese');
    expect(unbacked?.textContent).toContain('kein Beleg');

    const backed = document.querySelector('[data-claim="claim-backed"]');
    expect(backed?.textContent).toContain('Beleg (Case Study)');
    expect(backed?.textContent).toContain('case-study/muster-bau');
  });
});
