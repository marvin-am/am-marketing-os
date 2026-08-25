/**
 * `@am/creative-renderer` — deterministic composition of Meta creatives.
 *
 * The image model produces the base motif only: no headline, no logo, no UI
 * text. Models render type unreliably and off-brand, so everything typographic
 * is composed here through a controlled template library, with real font
 * metrics, verified WCAG AA contrast and full provenance on every rendition.
 *
 * Server-side Node only — it depends on sharp.
 */

export * from './types';
export * from './geometry';
export * from './color';
export * from './contrast';
export * from './fonts';
export * from './text';
export * from './xml';
export * from './content';
export * from './alt-text';
export * from './templates';
export * from './compose';
export * from './variants';
export * from './storage';
export * from './fixtures';
