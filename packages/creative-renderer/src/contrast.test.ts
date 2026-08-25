import { describe, expect, it } from 'vitest';
import {
  bestContrastColor,
  blendOver,
  contrastRatio,
  mix,
  parseHex,
  relativeLuminance,
  toHex,
} from './color';
import {
  WCAG_AA_LARGE,
  WCAG_AA_NORMAL,
  aaTargetFor,
  meetsWcagAa,
  resolveLegibility,
  worstCaseBackdrop,
} from './contrast';

describe('colour maths', () => {
  it('parses short and long hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#D7182A')).toEqual({ r: 215, g: 24, b: 42 });
  });

  it('rejects an invalid colour instead of guessing', () => {
    expect(() => parseHex('rot')).toThrow();
  });

  it('round-trips through hex', () => {
    expect(toHex(parseHex('#0A5C36'))).toBe('#0A5C36');
  });

  it('matches the WCAG reference values', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 4);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1);
  });

  it('composites an overlay over a base', () => {
    expect(toHex(blendOver('#000000', '#FFFFFF', 0.5))).toBe('#808080');
    expect(toHex(mix('#000000', '#FFFFFF', 1))).toBe('#FFFFFF');
  });

  it('picks the strongest candidate', () => {
    expect(bestContrastColor('#D7182A', ['#FFFFFF', '#111111']).color).toBe('#FFFFFF');
    expect(bestContrastColor('#F7F5EF', ['#FFFFFF', '#111111']).color).toBe('#111111');
  });
});

describe('WCAG thresholds', () => {
  it('uses the large-text threshold only above the size cut-off', () => {
    expect(aaTargetFor(30, true)).toBe(WCAG_AA_LARGE);
    expect(aaTargetFor(18, true)).toBe(WCAG_AA_NORMAL);
    expect(aaTargetFor(26, false)).toBe(WCAG_AA_NORMAL);
    expect(aaTargetFor(32, false)).toBe(WCAG_AA_LARGE);
  });

  it('rejects a ratio just under the threshold', () => {
    expect(meetsWcagAa(4.49, WCAG_AA_NORMAL)).toBe(false);
    expect(meetsWcagAa(4.5, WCAG_AA_NORMAL)).toBe(true);
  });
});

describe('resolveLegibility', () => {
  it('rejects white on white and fixes it by changing the scrim', () => {
    // The failing configuration on its own: no contrast at all.
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 6);
    expect(meetsWcagAa(contrastRatio('#FFFFFF', '#FFFFFF'), WCAG_AA_NORMAL)).toBe(false);

    const resolution = resolveLegibility({
      backdrop: '#FFFFFF',
      textColor: '#FFFFFF',
      scrimColor: '#FFFFFF',
      baseOpacity: 0.2,
      target: WCAG_AA_NORMAL,
      fallbackScrims: ['#000000'],
    });

    expect(resolution.passes).toBe(true);
    expect(resolution.ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
    expect(resolution.scrimColor).toBe('#000000');
    expect(resolution.opacity).toBeGreaterThan(0.2);
    expect(resolution.adjustments.join(' ')).toMatch(/Overlay-Farbe/);
    // The reported ratio must describe the backdrop the text really sits on.
    expect(contrastRatio(resolution.textColor, resolution.effectiveBackdrop)).toBeCloseTo(
      resolution.ratio,
      1,
    );
  });

  it('raises the opacity of the intended scrim when that is enough', () => {
    // White text on a light photograph: 10 % black is nowhere near 4.5:1.
    const resolution = resolveLegibility({
      backdrop: '#C8C8C8',
      textColor: '#FFFFFF',
      scrimColor: '#000000',
      baseOpacity: 0.1,
      target: WCAG_AA_NORMAL,
    });
    expect(contrastRatio('#FFFFFF', blendOver('#000000', '#C8C8C8', 0.1))).toBeLessThan(
      WCAG_AA_NORMAL,
    );
    expect(resolution.passes).toBe(true);
    expect(resolution.scrimColor).toBe('#000000');
    expect(resolution.opacity).toBeGreaterThan(0.3);
    expect(resolution.adjustments.join(' ')).toMatch(/Abdunklung/);
  });

  it('uses the smallest scrim that clears the threshold', () => {
    const resolution = resolveLegibility({
      backdrop: '#C8C8C8',
      textColor: '#FFFFFF',
      scrimColor: '#000000',
      baseOpacity: 0,
      target: WCAG_AA_NORMAL,
    });
    const oneStepLighter = contrastRatio(
      '#FFFFFF',
      blendOver('#000000', '#C8C8C8', resolution.opacity - 0.02),
    );
    expect(meetsWcagAa(oneStepLighter, WCAG_AA_NORMAL)).toBe(false);
  });

  it('leaves an already-passing configuration untouched', () => {
    const resolution = resolveLegibility({
      backdrop: '#111111',
      textColor: '#FFFFFF',
      scrimColor: '#000000',
      baseOpacity: 0.2,
      target: WCAG_AA_LARGE,
    });
    expect(resolution.passes).toBe(true);
    expect(resolution.opacity).toBe(0.2);
    expect(resolution.adjustments).toHaveLength(0);
  });

  it('falls back to swapping the text colour when no scrim can win', () => {
    const resolution = resolveLegibility({
      backdrop: '#FFFFFF',
      textColor: '#FFFFFF',
      scrimColor: '#FFFFFF',
      baseOpacity: 0.3,
      target: WCAG_AA_NORMAL,
      fallbackScrims: ['#FEFEFE'],
      fallbackTextColors: ['#111111'],
    });
    expect(resolution.passes).toBe(true);
    expect(resolution.textColor).toBe('#111111');
    expect(resolution.adjustments.join(' ')).toMatch(/Textfarbe/);
  });

  it('reports failure honestly when nothing can reach the target', () => {
    const resolution = resolveLegibility({
      backdrop: '#FFFFFF',
      textColor: '#FFFFFF',
      scrimColor: '#FFFFFF',
      baseOpacity: 0.3,
      target: WCAG_AA_NORMAL,
      fallbackScrims: [],
      fallbackTextColors: ['#FAFAFA'],
    });
    expect(resolution.passes).toBe(false);
    expect(resolution.ratio).toBeLessThan(WCAG_AA_NORMAL);
    expect(resolution.adjustments.join(' ')).toMatch(/unter AA/);
  });
});

describe('worstCaseBackdrop', () => {
  it('shifts a photographic mean towards the light for light text', () => {
    const backdrop = worstCaseBackdrop(
      { r: 120, g: 120, b: 120 },
      { r: 40, g: 40, b: 40 },
      '#FFFFFF',
    );
    expect(backdrop.r).toBe(160);
  });

  it('shifts towards the dark for dark text', () => {
    const backdrop = worstCaseBackdrop(
      { r: 120, g: 120, b: 120 },
      { r: 40, g: 40, b: 40 },
      '#111111',
    );
    expect(backdrop.r).toBe(80);
  });

  it('clamps at the channel bounds', () => {
    const bright = worstCaseBackdrop({ r: 250, g: 250, b: 250 }, { r: 40, g: 40, b: 40 }, '#FFFFFF');
    expect(bright.r).toBe(255);
  });
});
