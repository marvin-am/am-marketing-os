import {
  anchorLink,
  internalLink,
  type EmbeddedFormRef,
  type HybridFunnelSpec,
  type LandingPageSpec,
  type PageBlock,
  type PageBlockType,
} from '@am/funnel-schema';
import { deriveKey, uniqueKey } from '../keys';
import { moveItem } from '../move';
import type { PageDocumentSpec } from '../port';

/**
 * Block operations for landing pages and hybrid funnels.
 *
 * Same contract as `form-ops`: pure functions over an immutable spec, no
 * validation of their own. `createBlock` materialises every field a block type
 * requires with real German copy — a half-filled block would only show up later
 * as a schema error the operator did not cause.
 *
 * There is deliberately no "change block type" operation. The types share
 * almost no fields, so switching would either drop content silently or invent
 * it; adding the right block and deleting the wrong one is the honest path.
 */

export const PAGE_LIMITS = {
  landingPageBlocks: { min: 2, max: 30 },
  hybridBlocks: { min: 1, max: 8 },
} as const;

export function blockLimitsFor(spec: PageDocumentSpec): { min: number; max: number } {
  return spec.kind === 'HYBRID' ? PAGE_LIMITS.hybridBlocks : PAGE_LIMITS.landingPageBlocks;
}

export function blockIds(spec: PageDocumentSpec): string[] {
  return spec.blocks.map((block) => block.blockId);
}

/**
 * A fully materialised block of `type`.
 *
 * `formRef` is required for `EMBEDDED_CONTACT`: a form reference points at a
 * concrete published form version, and inventing that pair of ids would be
 * exactly the fabricated external the rules forbid.
 */
export function createBlock(
  type: PageBlockType,
  blockId: string,
  formRef: EmbeddedFormRef | null,
): PageBlock | null {
  const base = { blockId, anchor: blockId };

  switch (type) {
    case 'HERO':
      return {
        ...base,
        type: 'HERO',
        eyebrow: null,
        headline: 'Überschrift, die den Nutzen benennt',
        subline: 'Ein Satz, der erklärt, für wen das Angebot gedacht ist.',
        bullets: [],
        primaryCta: {
          label: 'Jetzt starten',
          action: 'OPEN_FORM',
          target: null,
          style: 'PRIMARY',
          note: null,
        },
        secondaryCta: null,
        media: null,
        trustNote: null,
      };
    case 'PROBLEM':
      return {
        ...base,
        type: 'PROBLEM',
        headline: 'Das Problem, das wir lösen',
        intro: null,
        points: [
          {
            key: 'punkt_1',
            title: 'Erster Problempunkt',
            body: 'Beschreiben Sie die Situation so, wie Betroffene sie selbst schildern würden.',
          },
        ],
      };
    case 'BENEFIT':
      return {
        ...base,
        type: 'BENEFIT',
        headline: 'Was sich dadurch ändert',
        intro: null,
        benefits: [
          {
            key: 'nutzen_1',
            title: 'Erster Nutzen',
            body: 'Beschreiben Sie den konkreten Unterschied im Alltag.',
            iconKey: null,
          },
        ],
      };
    case 'PROOF':
      return {
        ...base,
        type: 'PROOF',
        headline: 'Was wir belegen können',
        points: [
          {
            key: 'beleg_1',
            label: 'Bezeichnung des Belegs',
            value: 'Wert',
            note: null,
            evidenceItemId: null,
            confidence: 'HYPOTHESIS',
          },
        ],
        sourceNote: null,
      };
    case 'CASE_STUDY':
      return {
        ...base,
        type: 'CASE_STUDY',
        headline: 'Beispiel aus der Praxis',
        caseStudyId: null,
        client: 'Betrieb mit 20 Mitarbeitenden',
        industry: null,
        challenge: 'Ausgangslage des Betriebs.',
        approach: 'Was gemeinsam umgesetzt wurde.',
        outcome: 'Was sich messbar verändert hat.',
        metrics: [],
        cta: null,
      };
    case 'TESTIMONIAL':
      return {
        ...base,
        type: 'TESTIMONIAL',
        headline: 'Was Kundinnen und Kunden sagen',
        testimonials: [
          {
            key: 'stimme_1',
            testimonialId: null,
            quote: 'Wörtliches Zitat, freigegeben von der zitierten Person.',
            authorName: 'Name der Person',
            authorRole: null,
            company: null,
            media: null,
          },
        ],
      };
    case 'PROCESS':
      return {
        ...base,
        type: 'PROCESS',
        headline: 'So läuft die Zusammenarbeit ab',
        intro: null,
        steps: [
          {
            key: 'schritt_1',
            title: 'Erster Schritt',
            body: 'Was in diesem Schritt passiert.',
            durationNote: null,
          },
          {
            key: 'schritt_2',
            title: 'Zweiter Schritt',
            body: 'Was in diesem Schritt passiert.',
            durationNote: null,
          },
        ],
      };
    case 'COMPARISON':
      return {
        ...base,
        type: 'COMPARISON',
        headline: 'Der Vergleich',
        intro: null,
        columns: [
          { key: 'bisher', label: 'Bisher', highlight: false },
          { key: 'mit_uns', label: 'Mit uns', highlight: true },
        ],
        rows: [
          { key: 'zeile_1', label: 'Vergleichskriterium', cells: ['Heute', 'Künftig'] },
        ],
      };
    case 'OBJECTION_HANDLING':
      return {
        ...base,
        type: 'OBJECTION_HANDLING',
        headline: 'Häufige Einwände — ehrlich beantwortet',
        objections: [
          {
            key: 'einwand_1',
            objection: 'Der Einwand, so wie er wirklich formuliert wird.',
            response: 'Die ehrliche Antwort, auch wenn sie einschränkt.',
          },
        ],
      };
    case 'FAQ':
      return {
        ...base,
        type: 'FAQ',
        headline: 'Häufige Fragen',
        items: [
          {
            key: 'frage_1',
            faqId: null,
            question: 'Erste Frage?',
            answer: 'Die Antwort, kurz und ohne Marketingsprache.',
          },
        ],
      };
    case 'CTA':
      return {
        ...base,
        type: 'CTA',
        headline: 'Der nächste Schritt',
        body: null,
        cta: {
          label: 'Jetzt anfragen',
          action: 'OPEN_FORM',
          target: null,
          style: 'PRIMARY',
          note: null,
        },
        urgencyNote: null,
      };
    case 'TRUST':
      return {
        ...base,
        type: 'TRUST',
        headline: 'Womit wir arbeiten',
        badges: [{ key: 'dsgvo', label: 'Verarbeitung nach DSGVO', note: null }],
        logos: [],
      };
    case 'BOOKING_CTA':
      return {
        ...base,
        type: 'BOOKING_CTA',
        headline: 'Termin vereinbaren',
        body: 'Was im Gespräch passiert und wie lange es dauert.',
        booking: {
          mode: 'LINK',
          target: null,
          label: 'Termin auswählen',
          helpText: 'Terminbuchung noch nicht verbunden.',
        },
      };
    case 'EMBEDDED_CONTACT':
      if (!formRef) return null;
      return {
        ...base,
        type: 'EMBEDDED_CONTACT',
        headline: 'Ihre Anfrage',
        body: null,
        form: formRef,
      };
    case 'FOOTER_LEGAL':
      return {
        ...base,
        type: 'FOOTER_LEGAL',
        companyLine: 'Firmenname, Straße, PLZ Ort',
        imprintLink: internalLink('/impressum'),
        privacyLink: internalLink('/datenschutz'),
        additionalLinks: [],
        disclaimers: [],
      };
    default:
      return null;
  }
}

export function addBlock(
  spec: PageDocumentSpec,
  type: PageBlockType,
  afterBlockId: string | null,
  formRef: EmbeddedFormRef | null,
): { spec: PageDocumentSpec; blockId: string } {
  const limits = blockLimitsFor(spec);
  if (spec.blocks.length >= limits.max) return { spec, blockId: '' };

  const blockId = uniqueKey(deriveKey(type.toLowerCase(), 'block'), blockIds(spec));
  const block = createBlock(type, blockId, formRef);
  if (!block) return { spec, blockId: '' };

  const index = afterBlockId
    ? spec.blocks.findIndex((entry) => entry.blockId === afterBlockId)
    : -1;
  const blocks = [...spec.blocks];
  blocks.splice(index >= 0 ? index + 1 : blocks.length, 0, block);

  return { spec: { ...spec, blocks } as PageDocumentSpec, blockId };
}

export function deleteBlock(spec: PageDocumentSpec, blockId: string): PageDocumentSpec {
  return {
    ...spec,
    blocks: spec.blocks.filter((block) => block.blockId !== blockId),
  } as PageDocumentSpec;
}

export function duplicateBlock(
  spec: PageDocumentSpec,
  blockId: string,
): { spec: PageDocumentSpec; blockId: string } {
  const index = spec.blocks.findIndex((block) => block.blockId === blockId);
  const original = spec.blocks[index];
  if (!original) return { spec, blockId };

  const newId = uniqueKey(`${blockId}_kopie`, blockIds(spec));
  const copy: PageBlock = {
    ...original,
    blockId: newId,
    anchor: original.anchor ? uniqueKey(`${original.anchor}_kopie`, blockIds(spec)) : null,
  };

  const blocks = [...spec.blocks];
  blocks.splice(index + 1, 0, copy);
  return { spec: { ...spec, blocks } as PageDocumentSpec, blockId: newId };
}

export function moveBlock(spec: PageDocumentSpec, from: number, to: number): PageDocumentSpec {
  return { ...spec, blocks: moveItem(spec.blocks, from, to) } as PageDocumentSpec;
}

export function updateBlock(
  spec: PageDocumentSpec,
  blockId: string,
  updater: (block: PageBlock) => PageBlock,
): PageDocumentSpec {
  return {
    ...spec,
    blocks: spec.blocks.map((block) => (block.blockId === blockId ? updater(block) : block)),
  } as PageDocumentSpec;
}

/** Anchors other blocks may link to, offered as a dropdown instead of free text. */
export function availableAnchors(spec: PageDocumentSpec): string[] {
  return spec.blocks
    .map((block) => block.anchor)
    .filter((anchor): anchor is string => Boolean(anchor));
}

export function anchorTargetFor(anchor: string) {
  return anchorLink(anchor);
}

/* -------------------------------------------------------------------------- */
/* Hybrid                                                                      */
/* -------------------------------------------------------------------------- */

export function isHybrid(spec: PageDocumentSpec): spec is HybridFunnelSpec {
  return spec.kind === 'HYBRID';
}

export function isLandingPage(spec: PageDocumentSpec): spec is LandingPageSpec {
  return spec.kind === 'LANDING_PAGE';
}

export function updateEmbeddedForm(
  spec: HybridFunnelSpec,
  updater: (form: EmbeddedFormRef) => EmbeddedFormRef,
): HybridFunnelSpec {
  return { ...spec, form: updater(spec.form) };
}

/** The form reference an `EMBEDDED_CONTACT` block should start from, if any. */
export function defaultFormRef(spec: PageDocumentSpec): EmbeddedFormRef | null {
  if (isHybrid(spec)) return spec.form;
  const embedded = spec.blocks.find((block) => block.type === 'EMBEDDED_CONTACT');
  return embedded && embedded.type === 'EMBEDDED_CONTACT' ? embedded.form : null;
}
