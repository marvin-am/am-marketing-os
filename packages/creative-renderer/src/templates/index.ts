/**
 * The controlled template library.
 *
 * Rule 5 of the working agreement: no model-authored markup ever reaches a
 * surface. A concept arriving from the AI pipeline picks one of these five
 * layouts by id and fills declared slots — it cannot invent a sixth layout, move
 * a box or change a colour.
 */

import { type CanvasGeometry } from '../geometry';
import { TEMPLATE_IDS, type BrandTokens, type TemplateId } from '../types';
import { boldStatementTemplate, renderBoldStatement } from './bold-statement';
import { comparisonTemplate, renderComparison } from './comparison';
import { dataPointTemplate, renderDataPoint } from './data-point';
import { quoteProofTemplate, renderQuoteProof } from './quote-proof';
import { renderSplitPanel, splitPanelTemplate } from './split-panel';
import type {
  CreativeTemplate,
  TemplateContrastPlan,
  TemplateInput,
  TemplateLayout,
} from './shared';

export const TEMPLATES: Readonly<Record<TemplateId, CreativeTemplate>> = {
  'bold-statement': boldStatementTemplate,
  'split-panel': splitPanelTemplate,
  'data-point': dataPointTemplate,
  'quote-proof': quoteProofTemplate,
  'comparison': comparisonTemplate,
};

export const TEMPLATE_LIST: readonly CreativeTemplate[] = TEMPLATE_IDS.map((id) => TEMPLATES[id]);

export function getTemplate(id: TemplateId): CreativeTemplate {
  const template = TEMPLATES[id];
  if (!template) {
    throw new Error(`Unbekanntes Creative-Template: ${id}`);
  }
  return template;
}

/** Pure `(input) => SVGString` for the chosen template. */
export function renderTemplate(id: TemplateId, input: TemplateInput): string {
  return getTemplate(id).render(input);
}

export function layoutTemplate(id: TemplateId, input: TemplateInput): TemplateLayout {
  return getTemplate(id).layout(input);
}

export function templateContrastPlan(
  id: TemplateId,
  canvas: CanvasGeometry,
  tokens: BrandTokens,
): TemplateContrastPlan {
  return getTemplate(id).plan(canvas, tokens);
}

export {
  boldStatementTemplate,
  splitPanelTemplate,
  dataPointTemplate,
  quoteProofTemplate,
  comparisonTemplate,
  renderBoldStatement,
  renderSplitPanel,
  renderDataPoint,
  renderQuoteProof,
  renderComparison,
};
export type { CreativeTemplate, TemplateContrastPlan, TemplateInput, TemplateLayout };
// Only the contract is public. The SVG primitives (`rect`, `line`, `path`, …)
// stay internal so `@am/creative-renderer` does not export a dozen generic
// names into every consumer.
export type { ResolvedScrim } from './shared';
