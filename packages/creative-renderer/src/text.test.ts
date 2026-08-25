import { describe, expect, it } from 'vitest';
import { advanceWidth, metricsFor } from './fonts';
import {
  autoFitText,
  blockFitsInside,
  fitSingleLine,
  lineBoxMetrics,
  measureLineWidth,
  truncateToWidth,
  wrapText,
} from './text';
import { LONG_GERMAN_HEADLINE } from './fixtures';

describe('font metrics', () => {
  it('carries real per-glyph advances, not a character-count average', () => {
    const bold = metricsFor('bold');
    // "i" and "W" differ by more than 3x in Helvetica — an average would hide that.
    expect(advanceWidth(bold, 'i'.codePointAt(0)!)).toBe(278);
    expect(advanceWidth(bold, 'W'.codePointAt(0)!)).toBe(944);
    expect(advanceWidth(bold, ' '.codePointAt(0)!)).toBe(278);
  });

  it('gives an umlaut the same advance as its base letter', () => {
    const regular = metricsFor('regular');
    expect(advanceWidth(regular, 'ä'.codePointAt(0)!)).toBe(
      advanceWidth(regular, 'a'.codePointAt(0)!),
    );
    expect(advanceWidth(regular, 'Ü'.codePointAt(0)!)).toBe(
      advanceWidth(regular, 'U'.codePointAt(0)!),
    );
  });

  it('knows the German sharp s and the euro sign', () => {
    const regular = metricsFor('regular');
    expect(advanceWidth(regular, 'ß'.codePointAt(0)!)).toBe(556);
    expect(advanceWidth(regular, '€'.codePointAt(0)!)).toBe(556);
  });
});

describe('measureLineWidth', () => {
  it('scales linearly with the font size', () => {
    const at50 = measureLineWidth('Potenzialanalyse', { weight: 'bold', fontSize: 50 });
    const at100 = measureLineWidth('Potenzialanalyse', { weight: 'bold', fontSize: 100 });
    expect(at100 / at50).toBeCloseTo(2, 5);
  });

  it('measures a wide word as wider than a narrow one of equal length', () => {
    const wide = measureLineWidth('WWWW', { weight: 'bold', fontSize: 40 });
    const narrow = measureLineWidth('iiii', { weight: 'bold', fontSize: 40 });
    expect(wide).toBeGreaterThan(narrow * 3);
  });

  it('adds letter spacing between glyphs only', () => {
    const plain = measureLineWidth('abc', { weight: 'regular', fontSize: 40 });
    const tracked = measureLineWidth('abc', { weight: 'regular', fontSize: 40, letterSpacing: 10 });
    expect(tracked - plain).toBeCloseTo(20, 5);
  });

  it('returns zero for an empty string', () => {
    expect(measureLineWidth('', { weight: 'bold', fontSize: 60 })).toBe(0);
  });
});

describe('wrapText', () => {
  const options = { weight: 'bold' as const, fontSize: 60, maxWidth: 600 };

  it('never produces a line wider than the box', () => {
    const lines = wrapText(LONG_GERMAN_HEADLINE, options);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureLineWidth(line, options)).toBeLessThanOrEqual(options.maxWidth + 0.5);
    }
  });

  it('hard-breaks a compound that is wider than the whole line', () => {
    const lines = wrapText('Wirtschaftlichkeitsberechnung', {
      weight: 'bold',
      fontSize: 90,
      maxWidth: 400,
    });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.endsWith('-')).toBe(true);
    for (const line of lines) {
      expect(measureLineWidth(line, { weight: 'bold', fontSize: 90 })).toBeLessThanOrEqual(400.5);
    }
  });

  it('keeps every word, in order', () => {
    const lines = wrapText('Mehr qualifizierte Anfragen pro Monat', options);
    expect(lines.join(' ')).toBe('Mehr qualifizierte Anfragen pro Monat');
  });
});

describe('truncateToWidth', () => {
  it('leaves a fitting string alone', () => {
    expect(truncateToWidth('kurz', { weight: 'regular', fontSize: 20, maxWidth: 500 })).toBe('kurz');
  });

  it('ellipsises and still fits', () => {
    const options = { weight: 'regular' as const, fontSize: 40, maxWidth: 200 };
    const result = truncateToWidth(LONG_GERMAN_HEADLINE, options);
    expect(result.endsWith('…')).toBe(true);
    expect(measureLineWidth(result, options)).toBeLessThanOrEqual(200.5);
  });
});

describe('autoFitText', () => {
  const box = { width: 900, height: 420 };

  it('fits a long German headline inside the box', () => {
    const block = autoFitText(LONG_GERMAN_HEADLINE, box, {
      weight: 'bold',
      maxFontSize: 140,
      minFontSize: 24,
      lineHeight: 1.1,
    });
    expect(block.truncated).toBe(false);
    expect(blockFitsInside(block, box)).toBe(true);
    expect(block.width).toBeLessThanOrEqual(box.width);
    expect(block.height).toBeLessThanOrEqual(box.height);
  });

  it('picks the largest size that still fits', () => {
    const block = autoFitText(LONG_GERMAN_HEADLINE, box, {
      weight: 'bold',
      maxFontSize: 140,
      minFontSize: 24,
      lineHeight: 1.1,
    });
    expect(block.fontSize).toBeGreaterThan(24);
    expect(block.fontSize).toBeLessThan(140);

    // One size up no longer fits, so the layout has to cut copy — which is
    // exactly what the chosen size avoids.
    const oneBigger = autoFitText(LONG_GERMAN_HEADLINE, box, {
      weight: 'bold',
      maxFontSize: block.fontSize + 1,
      minFontSize: block.fontSize + 1,
      lineHeight: 1.1,
    });
    expect(oneBigger.truncated).toBe(true);
  });

  it('shrinks a longer headline more than a short one', () => {
    const short = autoFitText('Mehr Umsatz', box, {
      weight: 'bold',
      maxFontSize: 140,
      minFontSize: 20,
      lineHeight: 1.1,
    });
    const long = autoFitText(LONG_GERMAN_HEADLINE, box, {
      weight: 'bold',
      maxFontSize: 140,
      minFontSize: 20,
      lineHeight: 1.1,
    });
    expect(long.fontSize).toBeLessThan(short.fontSize);
  });

  it('truncates rather than overflowing when nothing fits', () => {
    const tiny = { width: 220, height: 60 };
    const block = autoFitText(LONG_GERMAN_HEADLINE, tiny, {
      weight: 'bold',
      maxFontSize: 60,
      minFontSize: 28,
      lineHeight: 1.1,
    });
    expect(block.truncated).toBe(true);
    expect(blockFitsInside(block, tiny)).toBe(true);
    expect(block.lines.join('').endsWith('…')).toBe(true);
  });

  it('respects a single-line constraint', () => {
    const block = fitSingleLine('38 %', { width: 600, height: 300 }, {
      weight: 'bold',
      maxFontSize: 280,
      minFontSize: 40,
      lineHeight: 1,
    });
    expect(block.lines).toHaveLength(1);
    expect(block.width).toBeLessThanOrEqual(600.5);
  });

  it('returns an empty block for empty copy', () => {
    const block = autoFitText('   ', box, {
      weight: 'bold',
      maxFontSize: 100,
      minFontSize: 20,
      lineHeight: 1.1,
    });
    expect(block.lines).toHaveLength(0);
    expect(block.height).toBe(0);
  });
});

describe('lineBoxMetrics', () => {
  it('places the first baseline below the top of the block', () => {
    const metrics = lineBoxMetrics(100, 1.2, 'bold');
    expect(metrics.lineHeightPx).toBe(120);
    expect(metrics.baselineOffset).toBeGreaterThan(metrics.ascentPx);
    expect(metrics.baselineOffset).toBeLessThan(metrics.lineHeightPx);
  });

  it('never lets the line box collapse below the glyph extent', () => {
    const metrics = lineBoxMetrics(100, 0.4, 'regular');
    expect(metrics.lineHeightPx).toBeGreaterThanOrEqual(95);
  });
});
