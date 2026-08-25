import { describe, expect, it } from 'vitest';
import { ASPECT_RATIOS, type AspectRatio } from '@am/domain';
import { canvasFor, rectContains } from '../geometry';
import { contentFromConcept } from '../content';
import {
  FIXTURE_ALT_BRAND_PROFILE,
  FIXTURE_BRAND_PROFILE,
  FIXTURE_COMPARISON_CONCEPT,
  FIXTURE_CONCEPT,
  LONG_GERMAN_HEADLINE,
} from '../fixtures';
import {
  TEMPLATE_IDS,
  brandTokensFromProfile,
  creativeContentSchema,
  type BrandTokens,
  type CreativeContent,
  type TemplateId,
} from '../types';
import { assertWellFormedSvg, findElements, parseXml } from '../xml';
import { TEMPLATES, TEMPLATE_LIST, getTemplate, renderTemplate } from './index';
import type { TemplateInput } from './shared';

const BRAND_TOKENS = brandTokensFromProfile(FIXTURE_BRAND_PROFILE);
const ALT_TOKENS = brandTokensFromProfile(FIXTURE_ALT_BRAND_PROFILE);

function inputFor(
  template: TemplateId,
  ratio: AspectRatio,
  overrides: {
    tokens?: BrandTokens;
    content?: Partial<CreativeContent>;
  } = {},
): TemplateInput {
  const tokens = overrides.tokens ?? BRAND_TOKENS;
  const concept = template === 'comparison' ? FIXTURE_COMPARISON_CONCEPT : FIXTURE_CONCEPT;
  const content = contentFromConcept(concept, {
    brandName: FIXTURE_BRAND_PROFILE.name,
    overrides: overrides.content,
  });
  const canvas = canvasFor(ratio);
  const plan = getTemplate(template).plan(canvas, tokens);
  return {
    canvas,
    tokens,
    content,
    scrim: { color: plan.scrimColor, opacity: Math.max(plan.baseOpacity, 0.5) },
    overlayTextColor: plan.textColor,
  };
}

describe('template registry', () => {
  it('exposes exactly five distinct templates', () => {
    expect(TEMPLATE_IDS).toHaveLength(5);
    expect(new Set(TEMPLATE_LIST.map((template) => template.id)).size).toBe(5);
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATES[id].id).toBe(id);
    }
  });

  it('rejects an unknown template id rather than falling back silently', () => {
    expect(() => getTemplate('nope' as TemplateId)).toThrow(/Unbekanntes Creative-Template/);
  });

  it('produces genuinely different layouts, not colour swaps', () => {
    const svgs = TEMPLATE_IDS.map((id) => renderTemplate(id, inputFor(id, '1:1')));
    expect(new Set(svgs).size).toBe(5);
    // Different structure, not just different fills: element counts differ.
    const shapes = svgs.map((svg) => {
      const root = parseXml(svg);
      return `${findElements(root, 'rect').length}/${findElements(root, 'text').length}/${findElements(root, 'circle').length}/${findElements(root, 'path').length}`;
    });
    expect(new Set(shapes).size).toBeGreaterThanOrEqual(4);
  });
});

describe.each(TEMPLATE_IDS)('template %s', (template) => {
  it.each(ASPECT_RATIOS)('renders parseable XML at %s', (ratio) => {
    const svg = renderTemplate(template, inputFor(template, ratio));
    const root = assertWellFormedSvg(svg);
    const canvas = canvasFor(ratio);
    expect(root.attributes.width).toBe(String(canvas.width));
    expect(root.attributes.height).toBe(String(canvas.height));
    expect(root.attributes.xmlns).toBe('http://www.w3.org/2000/svg');
    expect(root.attributes.viewBox).toBe(`0 0 ${canvas.width} ${canvas.height}`);
    expect(findElements(root, 'text').length).toBeGreaterThan(0);
  });

  it.each(ASPECT_RATIOS)('keeps every text block inside the safe area at %s', (ratio) => {
    const canvas = canvasFor(ratio);
    const layout = getTemplate(template).layout(inputFor(template, ratio));
    for (const bound of layout.bounds) {
      expect(
        rectContains(canvas.safe, bound, 1),
        `${template} ${ratio}: block at ${JSON.stringify(bound)} escapes ${JSON.stringify(canvas.safe)}`,
      ).toBe(true);
    }
  });

  it.each(ASPECT_RATIOS)(
    'keeps a very long German headline inside the canvas at %s',
    (ratio) => {
      const canvas = canvasFor(ratio);
      const layout = getTemplate(template).layout(
        inputFor(template, ratio, {
          content: {
            headline: LONG_GERMAN_HEADLINE,
            quote: LONG_GERMAN_HEADLINE,
            statCaption: LONG_GERMAN_HEADLINE,
            subline: LONG_GERMAN_HEADLINE,
            sourceLine: LONG_GERMAN_HEADLINE,
          },
        }),
      );
      for (const bound of layout.bounds) {
        expect(bound.x).toBeGreaterThanOrEqual(-1);
        expect(bound.y).toBeGreaterThanOrEqual(-1);
        expect(bound.x + bound.width).toBeLessThanOrEqual(canvas.width + 1);
        expect(bound.y + bound.height).toBeLessThanOrEqual(canvas.height + 1);
      }
      // And it is still valid markup after all that shrinking.
      assertWellFormedSvg(layout.svg);
    },
  );

  it('escapes hostile copy instead of letting it close a tag', () => {
    const hostile = 'Preis & Leistung <script>alert("x")</script> "sofort"';
    const svg = renderTemplate(
      template,
      inputFor(template, '1:1', {
        content: {
          headline: hostile,
          subline: hostile,
          callToAction: 'Mehr & mehr',
          kicker: '<b>',
          quote: hostile,
          statCaption: hostile,
          sourceLine: hostile,
          attributionName: 'A & M "GmbH"',
        },
      }),
    );
    const root = assertWellFormedSvg(svg);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&amp;');
    const texts = findElements(root, 'text').map((node) => node.text);
    expect(texts.some((text) => text.includes('&lt;script&gt;'))).toBe(true);
  });

  it('is pure: the same input renders byte-identical markup', () => {
    const input = inputFor(template, '4:5');
    expect(renderTemplate(template, input)).toBe(renderTemplate(template, input));
  });

  it('carries the brand tokens through instead of hard-coding A&M red', () => {
    const alt = renderTemplate(template, inputFor(template, '1:1', { tokens: ALT_TOKENS }));
    expect(alt).toContain(FIXTURE_ALT_BRAND_PROFILE.colors.primary);
    expect(alt).not.toContain(FIXTURE_BRAND_PROFILE.colors.primary);
    expect(alt.toLowerCase()).not.toContain('#d7182a');
  });

  it('declares a contrast plan for every ratio', () => {
    for (const ratio of ASPECT_RATIOS) {
      const canvas = canvasFor(ratio);
      const plan = getTemplate(template).plan(canvas, BRAND_TOKENS);
      expect(plan.baseOpacity).toBeGreaterThanOrEqual(0);
      expect(plan.baseOpacity).toBeLessThanOrEqual(1);
      expect(plan.textColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(plan.scrimColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(plan.sampleRect.width).toBeGreaterThan(0);
      expect(plan.sampleRect.height).toBeGreaterThan(0);
      expect(plan.sampleRect.x).toBeGreaterThanOrEqual(0);
      expect(plan.sampleRect.x + plan.sampleRect.width).toBeLessThanOrEqual(canvas.width);
      expect(plan.sampleRect.y + plan.sampleRect.height).toBeLessThanOrEqual(canvas.height);
    }
  });

  it('reports how each text slot was fitted', () => {
    const layout = getTemplate(template).layout(inputFor(template, '4:5'));
    expect(layout.fits.length).toBeGreaterThan(0);
    for (const fit of layout.fits) {
      expect(fit.fontSizePx).toBeGreaterThan(0);
      expect(fit.widthPx).toBeLessThanOrEqual(fit.boxWidthPx + 0.5);
      expect(fit.heightPx).toBeLessThanOrEqual(fit.boxHeightPx + 0.5);
    }
  });

  it('renders with every optional slot empty', () => {
    const bare = creativeContentSchema.parse({
      headline: 'Kurz',
      callToAction: 'Los',
    });
    const canvas = canvasFor('1:1');
    const plan = getTemplate(template).plan(canvas, BRAND_TOKENS);
    const svg = renderTemplate(template, {
      canvas,
      tokens: { ...BRAND_TOKENS, wordmark: null },
      content: bare,
      scrim: { color: plan.scrimColor, opacity: plan.baseOpacity },
      overlayTextColor: plan.textColor,
    });
    assertWellFormedSvg(svg);
  });
});
