/**
 * Colour maths for legibility checks.
 *
 * Everything here is sRGB and WCAG 2.1: relative luminance, contrast ratio and
 * alpha compositing, so a scrim opacity can be *solved for* rather than eyeballed.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(value: string): boolean {
  return HEX_PATTERN.test(value);
}

/** Parses `#rgb` / `#rrggbb` into 0..255 channels. Throws on anything else. */
export function parseHex(value: string): Rgb {
  const match = HEX_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Ungültiger Farbwert: ${value}`);
  let hex = match[1]!;
  if (hex.length === 3) {
    hex = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function toHex(rgb: Rgb): string {
  const part = (value: number): string => clampChannel(value).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`.toUpperCase();
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(color: Rgb | string): number {
  const rgb = typeof color === 'string' ? parseHex(color) : color;
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

/** WCAG contrast ratio between two opaque colours, 1 .. 21. */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Composites `overlay` at `alpha` over `base` (source-over, no gamma games). */
export function blendOver(overlay: Rgb | string, base: Rgb | string, alpha: number): Rgb {
  const top = typeof overlay === 'string' ? parseHex(overlay) : overlay;
  const bottom = typeof base === 'string' ? parseHex(base) : base;
  const a = Math.min(1, Math.max(0, alpha));
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
  };
}

/** Linear mix, `amount` = 0 keeps `from`, 1 reaches `to`. */
export function mix(from: Rgb | string, to: Rgb | string, amount: number): Rgb {
  return blendOver(to, from, amount);
}

/** Moves a colour towards black. */
export function darken(color: Rgb | string, amount: number): Rgb {
  return mix(color, { r: 0, g: 0, b: 0 }, amount);
}

/** Moves a colour towards white. */
export function lighten(color: Rgb | string, amount: number): Rgb {
  return mix(color, { r: 255, g: 255, b: 255 }, amount);
}

/** Picks whichever candidate contrasts most strongly with `backdrop`. */
export function bestContrastColor(
  backdrop: Rgb | string,
  candidates: readonly string[],
): { color: string; ratio: number } {
  let best = { color: candidates[0] ?? '#000000', ratio: 0 };
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, backdrop);
    if (ratio > best.ratio) best = { color: candidate, ratio };
  }
  return best;
}

/** Formats an RGB triple as an SVG-safe hex string. */
export function svgColor(color: Rgb | string): string {
  return typeof color === 'string' ? color.toUpperCase() : toHex(color);
}
