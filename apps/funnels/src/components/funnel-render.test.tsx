import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  LANDING_PAGE_SPEC,
  PAGE_BLOCK_TYPES,
  POTENZIALANALYSE_FORM_SPEC,
  QUALIFIED_ANSWERS,
  externalLink,
  internalLink,
  type PageBlock,
  type PageBlockType,
  type ResultVariant,
} from '@am/funnel-schema';
import { PageBlocks } from './page-blocks';
import { ResultView } from './result-view';
import { resolveFormTargets } from '@/server/spec-targets';

/**
 * Rendering coverage for the two surfaces a spec can address.
 *
 * The point of the block list and the result-variant union is that an author —
 * or the AI pipeline — can only produce shapes the runtime knows how to draw. A
 * type the renderer silently drops turns a published page into a half-empty one,
 * so every member of both unions is exercised here.
 */

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

function minimalBlock(type: PageBlockType): PageBlock {
  const base = { blockId: `block_${type.toLowerCase()}`, anchor: null } as const;
  const cta = {
    label: 'Jetzt anfragen',
    action: 'LINK' as const,
    target: internalLink('/f/potenzialanalyse'),
    style: 'PRIMARY' as const,
    note: null,
  };

  switch (type) {
    case 'HERO':
      return {
        ...base,
        type,
        eyebrow: 'Für Betriebe',
        headline: 'Planbare Anfragen',
        subline: 'Statt Empfehlungsglück.',
        bullets: ['Passende Anfragen'],
        primaryCta: cta,
        secondaryCta: null,
        media: { kind: 'IMAGE', assetPath: '/assets/hero.webp', alt: 'Team', aspect: '16:9' },
        trustNote: 'Keine Erfolgsversprechen.',
      };
    case 'PROBLEM':
      return {
        ...base,
        type,
        headline: 'Das Problem',
        intro: null,
        points: [{ key: 'p1', title: 'Abhängigkeit', body: 'Empfehlungen sind nicht planbar.' }],
      };
    case 'BENEFIT':
      return {
        ...base,
        type,
        headline: 'Der Nutzen',
        intro: null,
        benefits: [
          { key: 'b1', title: 'Planbarkeit', body: 'Budget steuert Anfragen.', iconKey: null },
        ],
      };
    case 'PROOF':
      return {
        ...base,
        type,
        headline: 'Belege',
        points: [
          {
            key: 'pp1',
            label: 'Betreute Betriebe',
            value: 'über 40',
            note: null,
            evidenceItemId: null,
            confidence: 'INDICATION',
          },
        ],
        sourceNote: null,
      };
    case 'CASE_STUDY':
      return {
        ...base,
        type,
        headline: 'Fallstudie',
        caseStudyId: null,
        client: 'Sanitärbetrieb',
        industry: 'Handwerk',
        challenge: 'Auftragslage schwankte.',
        approach: 'Anfragestrecke aufgebaut.',
        outcome: 'Zwei Quellen statt einer.',
        metrics: [{ key: 'm1', label: 'Anfragen pro Monat', value: '9 bis 14' }],
        cta: null,
      };
    case 'TESTIMONIAL':
      return {
        ...base,
        type,
        headline: 'Kundenstimmen',
        testimonials: [
          {
            key: 't1',
            testimonialId: null,
            quote: 'Endlich planbar.',
            authorName: 'K. Bergmann',
            authorRole: 'Geschäftsführerin',
            company: null,
            media: null,
          },
        ],
      };
    case 'PROCESS':
      return {
        ...base,
        type,
        headline: 'Ablauf',
        intro: null,
        steps: [
          { key: 's1', title: 'Analyse', body: 'Fünf Fragen.', durationNote: '2 Minuten' },
          { key: 's2', title: 'Gespräch', body: 'Auswertung.', durationNote: null },
        ],
      };
    case 'COMPARISON':
      return {
        ...base,
        type,
        headline: 'Vergleich',
        intro: null,
        columns: [
          { key: 'c1', label: 'Empfehlung', highlight: false },
          { key: 'c2', label: 'Eigene Strecke', highlight: true },
        ],
        rows: [{ key: 'r1', label: 'Planbarkeit', cells: ['Zufällig', 'Steuerbar'] }],
      };
    case 'OBJECTION_HANDLING':
      return {
        ...base,
        type,
        headline: 'Einwände',
        objections: [
          { key: 'o1', objection: 'Wir sind zu klein.', response: 'Unter 500 € lohnt es nicht.' },
        ],
      };
    case 'FAQ':
      return {
        ...base,
        type,
        headline: 'Häufige Fragen',
        items: [{ key: 'f1', faqId: null, question: 'Mindestlaufzeit?', answer: 'Monatlich kündbar.' }],
      };
    case 'CTA':
      return { ...base, type, headline: 'Jetzt starten', body: null, cta, urgencyNote: null };
    case 'TRUST':
      return {
        ...base,
        type,
        headline: 'Vertrauen',
        badges: [{ key: 'bd1', label: 'Verarbeitung nach DSGVO', note: null }],
        logos: [{ key: 'lg1', label: 'Partner', media: null }],
      };
    case 'BOOKING_CTA':
      return {
        ...base,
        type,
        headline: 'Termin buchen',
        body: 'Wählen Sie einen Termin.',
        /* No meeting link supplied yet — the honest state, never an invented URL. */
        booking: { mode: 'LINK', target: null, label: 'Termin auswählen', helpText: null },
      };
    case 'EMBEDDED_CONTACT':
      return {
        ...base,
        type,
        headline: 'Anfrage senden',
        body: null,
        form: {
          mode: 'INLINE',
          formId: POTENZIALANALYSE_FORM_SPEC.formId,
          formVersionId: POTENZIALANALYSE_FORM_SPEC.formVersionId,
          triggerLabel: 'Formular öffnen',
          anchorBlockId: null,
        },
      };
    case 'FOOTER_LEGAL':
      return {
        ...base,
        type,
        companyLine: 'A&M Marketing GmbH',
        imprintLink: internalLink('/impressum'),
        privacyLink: internalLink('/datenschutz'),
        additionalLinks: [],
        disclaimers: ['Erfahrungswerte, keine Zusagen.'],
      };
    default:
      throw new Error(`Kein Test-Block für ${type satisfies never}`);
  }
}

const FIXED_WIDTH_CLASS = /(?:^|:)(?:min-)?w-\[(\d+(?:\.\d+)?)px\]/;

function oversizedElements(root: HTMLElement, viewport: number): string[] {
  const offenders: string[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    /* An element inside a scroll container is allowed to exceed the viewport —
       it scrolls itself and the page does not. */
    if (element.closest('.overflow-x-auto') !== null) continue;
    for (const token of (element.getAttribute('class') ?? '').split(/\s+/)) {
      if (token.includes('w-screen')) offenders.push(`${element.tagName}.${token}`);
      const match = FIXED_WIDTH_CLASS.exec(token);
      if (match && Number(match[1]) > viewport) offenders.push(`${element.tagName}.${token}`);
    }
    for (const property of ['width', 'minWidth'] as const) {
      const declared = element.style[property];
      if (declared.endsWith('px') && Number.parseFloat(declared) > viewport) {
        offenders.push(`${element.tagName}[style.${property}=${declared}]`);
      }
    }
  }
  return offenders;
}

describe('landing page blocks', () => {
  it('renders every block type the schema can express', () => {
    const blocks = PAGE_BLOCK_TYPES.map(minimalBlock);
    const { container } = render(<PageBlocks blocks={blocks} redirectAllowlist={[]} />);

    /* One rendered section (or footer) per block: nothing is silently dropped. */
    expect(container.querySelectorAll('section, footer')).toHaveLength(PAGE_BLOCK_TYPES.length);
  });

  it('declares no element wider than a 320 px viewport', () => {
    const { container } = render(
      <PageBlocks blocks={LANDING_PAGE_SPEC.blocks} redirectAllowlist={[]} />,
    );
    expect(oversizedElements(container, 320)).toEqual([]);
  });

  it('reserves the hero image box before the bytes arrive', () => {
    const { container } = render(
      <PageBlocks blocks={[minimalBlock('HERO')]} redirectAllowlist={[]} />,
    );
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('width', '1280');
    expect(image).toHaveAttribute('height', '720');
    expect(image?.style.aspectRatio).toBe('16 / 9');
  });

  it('says a booking link is missing instead of rendering a dead button', () => {
    render(<PageBlocks blocks={[minimalBlock('BOOKING_CTA')]} redirectAllowlist={[]} />);
    expect(screen.getByText(/noch nicht verbunden/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Termin auswählen' })).toBeNull();
  });

  it('hosts the form runtime inside an embedded-contact block', () => {
    render(
      <PageBlocks
        blocks={[minimalBlock('EMBEDDED_CONTACT')]}
        redirectAllowlist={[]}
        embeddedForm={<p data-testid="formular">Formular</p>}
      />,
    );
    /* Otherwise the block is a headline with nothing under it — a "coming soon"
       page by another name. */
    expect(screen.getByTestId('formular')).toBeInTheDocument();
  });

  it('refuses an external CTA whose host is not allow-listed', () => {
    const block = minimalBlock('CTA');
    const withExternal: PageBlock = {
      ...(block as Extract<PageBlock, { type: 'CTA' }>),
      cta: {
        label: 'Zum Partner',
        action: 'LINK',
        target: externalLink('https://fremd.example/angebot'),
        style: 'PRIMARY',
        note: null,
      },
    };

    render(<PageBlocks blocks={[withExternal]} redirectAllowlist={['example.com']} />);
    expect(screen.queryByRole('link', { name: 'Zum Partner' })).toBeNull();
    expect(screen.getByText(/nicht freigegeben/)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Result states                                                               */
/* -------------------------------------------------------------------------- */

const TARGETS = resolveFormTargets(POTENZIALANALYSE_FORM_SPEC, ['example.com']);

function variant(kind: ResultVariant['kind']): ResultVariant {
  const base: Pick<ResultVariant, 'variantId' | 'forOutcomes' | 'showWhen' | 'headline' | 'body'> = {
    variantId: `v_${kind.toLowerCase()}`,
    /* Empty means "any outcome" — the variant is chosen by `kind` here. */
    forOutcomes: [],
    showWhen: null,
    headline: 'Überschrift',
    body: 'Fließtext.',
  };

  switch (kind) {
    case 'THANK_YOU':
      return { ...base, kind, bullets: ['Auswertung per E-Mail'], cta: null };
    case 'LEAD_MAGNET':
      return {
        ...base,
        kind,
        assetPath: null,
        assetLabel: 'Leitfaden',
        deliveryNote: 'Prüfen Sie den Spam-Ordner.',
      };
    case 'ANALYSIS':
      return {
        ...base,
        kind,
        sections: [
          { key: 'immer', title: 'Ihre Einordnung', body: 'Immer sichtbar.', showWhen: null },
          {
            key: 'nur_bei_budget',
            title: 'Besonderes Potenzial',
            body: 'Nur bei hohem Budget.',
            showWhen: { all: [{ fieldId: 'werbebudget', operator: 'EQUALS', value: 'ueber_4000' }] },
          },
          {
            key: 'nie',
            title: 'Nicht sichtbar',
            body: 'Bedingung trifft nicht zu.',
            showWhen: { all: [{ fieldId: 'werbebudget', operator: 'EQUALS', value: 'unter_500' }] },
          },
        ],
        cta: null,
        methodNote: 'Keine Garantie.',
      };
    case 'QUALIFIED':
      return { ...base, kind, bullets: [], cta: null, booking: null };
    case 'NOT_A_FIT':
      return { ...base, kind, alternativeNote: 'Melden Sie sich gerne später erneut.', cta: null };
    case 'BOOKING':
      return {
        ...base,
        kind,
        booking: { mode: 'LINK', target: null, label: 'Termin', helpText: null },
        bullets: [],
      };
    case 'REDIRECT':
      return {
        ...base,
        kind,
        target: externalLink('https://fremd.example/danke'),
        delaySeconds: 5,
      };
    default:
      throw new Error(`Keine Test-Variante für ${kind satisfies never}`);
  }
}

describe('result states', () => {
  const kinds: ResultVariant['kind'][] = [
    'THANK_YOU',
    'LEAD_MAGNET',
    'ANALYSIS',
    'QUALIFIED',
    'NOT_A_FIT',
    'BOOKING',
    'REDIRECT',
  ];

  it.each(kinds)('renders the %s state', (kind) => {
    render(
      <ResultView
        spec={POTENZIALANALYSE_FORM_SPEC}
        variant={variant(kind)}
        targets={TARGETS}
        answers={QUALIFIED_ANSWERS}
        redirect={null}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Überschrift');
  });

  it('shows only the analysis sections whose condition matches', () => {
    render(
      <ResultView
        spec={POTENZIALANALYSE_FORM_SPEC}
        variant={variant('ANALYSIS')}
        targets={TARGETS}
        answers={QUALIFIED_ANSWERS}
        redirect={null}
      />,
    );

    expect(screen.getByText('Ihre Einordnung')).toBeInTheDocument();
    expect(screen.getByText('Besonderes Potenzial')).toBeInTheDocument();
    expect(screen.queryByText('Nicht sichtbar')).toBeNull();
    /* Every computed statement carries its method note. */
    expect(screen.getByText('Keine Garantie.')).toBeInTheDocument();
  });

  it('keeps the visitor here when a redirect target was not allow-listed', () => {
    render(
      <ResultView
        spec={POTENZIALANALYSE_FORM_SPEC}
        variant={variant('REDIRECT')}
        targets={TARGETS}
        answers={QUALIFIED_ANSWERS}
        redirect={null}
      />,
    );

    expect(screen.getByText(/Weiterleitung ist nicht freigegeben/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('falls back to the success spec when no variant was selected', () => {
    render(
      <ResultView
        spec={POTENZIALANALYSE_FORM_SPEC}
        variant={null}
        targets={TARGETS}
        answers={QUALIFIED_ANSWERS}
        redirect={null}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      POTENZIALANALYSE_FORM_SPEC.success.headline,
    );
  });
});
