import { describe, expect, it } from 'vitest';
import { ASPECT_RATIOS, REQUIRED_ASPECT_RATIOS } from '@am/domain';
import {
  RATIO_DIMENSIONS,
  canvasFor,
  clampRectToPixels,
  coverCrop,
  denormalizeRect,
  insetRect,
  normalizeRect,
  rectContains,
} from './geometry';

describe('canvasFor', () => {
  it('produces Meta’s pixel dimensions for every supported ratio', () => {
    expect(canvasFor('1:1')).toMatchObject({ width: 1080, height: 1080 });
    expect(canvasFor('4:5')).toMatchObject({ width: 1080, height: 1350 });
    expect(canvasFor('9:16')).toMatchObject({ width: 1080, height: 1920 });
  });

  it('covers both required ratios', () => {
    for (const ratio of REQUIRED_ASPECT_RATIOS) {
      expect(RATIO_DIMENSIONS[ratio]).toBeDefined();
    }
  });

  it('keeps the safe rectangle inside the canvas', () => {
    for (const ratio of ASPECT_RATIOS) {
      const canvas = canvasFor(ratio);
      expect(canvas.safe.x).toBeGreaterThan(0);
      expect(canvas.safe.y).toBeGreaterThan(0);
      expect(canvas.safe.x + canvas.safe.width).toBeLessThan(canvas.width);
      expect(canvas.safe.y + canvas.safe.height).toBeLessThan(canvas.height);
    }
  });

  it('reserves the Stories UI bands at 9:16', () => {
    const story = canvasFor('9:16');
    // Meta covers roughly the top 14 % and bottom 20 % of a Reels placement.
    expect(story.insets.top / story.height).toBeGreaterThanOrEqual(0.13);
    expect(story.insets.bottom / story.height).toBeGreaterThanOrEqual(0.19);
    expect(story.safe.y).toBeGreaterThanOrEqual(268);
    expect(story.height - (story.safe.y + story.safe.height)).toBeGreaterThanOrEqual(383);
  });

  it('reserves far less at feed ratios than in Stories', () => {
    expect(canvasFor('1:1').insets.top).toBeLessThan(canvasFor('9:16').insets.top);
  });
});

describe('rect helpers', () => {
  const outer = { x: 0, y: 0, width: 100, height: 100 };

  it('detects containment with a tolerance', () => {
    expect(rectContains(outer, { x: 10, y: 10, width: 50, height: 50 })).toBe(true);
    expect(rectContains(outer, { x: 60, y: 10, width: 50, height: 50 })).toBe(false);
    expect(rectContains(outer, { x: -0.4, y: 0, width: 100, height: 100 })).toBe(true);
  });

  it('insets on all sides', () => {
    expect(insetRect(outer, 10)).toEqual({ x: 10, y: 10, width: 80, height: 80 });
    expect(insetRect(outer, { left: 20 })).toEqual({ x: 20, y: 0, width: 80, height: 100 });
  });

  it('round-trips normalised coordinates', () => {
    const canvas = canvasFor('4:5');
    const rect = { x: 108, y: 135, width: 540, height: 675 };
    expect(denormalizeRect(normalizeRect(rect, canvas), canvas)).toEqual(rect);
  });

  it('clamps an extraction window into the image', () => {
    const clamped = clampRectToPixels({ x: -20, y: 90, width: 200, height: 200 }, {
      width: 100,
      height: 100,
    });
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(90);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(100);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(100);
  });
});

describe('coverCrop', () => {
  it('always covers the target box', () => {
    for (const ratio of ASPECT_RATIOS) {
      const target = RATIO_DIMENSIONS[ratio];
      const crop = coverCrop({ width: 1600, height: 900 }, target);
      expect(crop.scaledWidth).toBeGreaterThanOrEqual(target.width);
      expect(crop.scaledHeight).toBeGreaterThanOrEqual(target.height);
      expect(crop.left + crop.width).toBeLessThanOrEqual(crop.scaledWidth);
      expect(crop.top + crop.height).toBeLessThanOrEqual(crop.scaledHeight);
    }
  });

  it('honours the focus point', () => {
    const target = { width: 1080, height: 1080 };
    const top = coverCrop({ width: 1600, height: 2400 }, target, { x: 0.5, y: 0.1 });
    const bottom = coverCrop({ width: 1600, height: 2400 }, target, { x: 0.5, y: 0.9 });
    expect(top.top).toBeLessThan(bottom.top);
    expect(top.top).toBe(0);
  });

  it('clamps a focus point at the edge instead of cropping outside', () => {
    const crop = coverCrop({ width: 1600, height: 2400 }, { width: 1080, height: 1080 }, {
      x: 0,
      y: 0,
    });
    expect(crop.left).toBe(0);
    expect(crop.top).toBe(0);
  });

  it('is deterministic', () => {
    const a = coverCrop({ width: 1601, height: 903 }, { width: 1080, height: 1350 }, { x: 0.37, y: 0.62 });
    const b = coverCrop({ width: 1601, height: 903 }, { width: 1080, height: 1350 }, { x: 0.37, y: 0.62 });
    expect(a).toEqual(b);
  });

  it('rejects a source without dimensions', () => {
    expect(() => coverCrop({ width: 0, height: 0 }, { width: 100, height: 100 })).toThrow();
  });
});
