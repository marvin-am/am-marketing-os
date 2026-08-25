import { expect, type Page } from '@playwright/test';

/**
 * Layout and accessibility assertions that check the real thing.
 *
 * Every helper here reports *what* failed, not just that something did: which
 * element sticks out of the viewport, which control is 32 px tall, which input
 * has no accessible name. A mobile-overflow failure that only says "expected
 * false to be true" costs more time than it saves.
 */

export interface OverflowReport {
  scrollWidth: number;
  clientWidth: number;
  bodyScrollWidth: number;
  offenders: { description: string; left: number; right: number; width: number }[];
}

/**
 * No horizontal overflow, checked two ways.
 *
 * The document-level comparison catches the common case; the per-element sweep
 * catches the one that matters more on a phone, where a single unbreakable
 * string widens one box without widening the document until the user scrolls.
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const result: OverflowReport = await page.evaluate(() => {
    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `${tag}${id}${cls}${text ? ` — "${text}"` : ''}`;
    }

    const root = document.documentElement;
    const viewport = root.clientWidth;
    const offenders: { description: string; left: number; right: number; width: number }[] = [];

    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      /* Deliberately off-screen, unreachable and aria-hidden: the honeypot. */
      if (el.closest('[aria-hidden="true"]')) continue;
      if (style.position === 'fixed') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      /* One pixel of slack for sub-pixel rounding at deviceScaleFactor > 1. */
      if (rect.right > viewport + 1 || rect.left < -1) {
        offenders.push({
          description: describe(el),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        });
      }
    }

    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders: offenders.slice(0, 5),
    };
  });

  expect(
    result.offenders,
    `Elemente ragen über den Viewport (${result.clientWidth} px) hinaus:\n` +
      result.offenders.map((o) => `  ${o.description} — ${o.left}…${o.right}`).join('\n'),
  ).toEqual([]);

  expect(
    result.scrollWidth,
    `Das Dokument scrollt horizontal: scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth}.`,
  ).toBeLessThanOrEqual(result.clientWidth);

  expect(result.bodyScrollWidth).toBeLessThanOrEqual(result.clientWidth);
}

/**
 * Every interactive control offers a hit target of at least 44 × 44 px.
 *
 * The measured box is the *label* wrapping a radio or checkbox where one
 * exists, because that is what the visitor's thumb actually hits — the 20 px
 * dot is only the part that is painted. Links that render inline inside running
 * text are exempt, matching WCAG 2.5.8's inline exception.
 */
export async function expectTouchTargets(page: Page, minimum = 44): Promise<void> {
  const offenders = await page.evaluate((min) => {
    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `${tag}${id}${text ? ` — "${text}"` : ''}`;
    }

    const selector = 'button, a[href], input, select, textarea, [role="button"]';
    const found: { description: string; width: number; height: number }[] = [];

    for (const el of Array.from(document.querySelectorAll(selector))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if ((el as HTMLInputElement).type === 'hidden') continue;
      /* WCAG 2.5.8 exempts a link inside a sentence of running text. */
      if (el.tagName === 'A' && style.display === 'inline') continue;

      const target = el.closest('label') ?? el;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.width + 0.5 < min || rect.height + 0.5 < min) {
        found.push({
          description: describe(el),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }
    return found.slice(0, 8);
  }, minimum);

  expect(
    offenders,
    `Bedienelemente unter ${minimum} × ${minimum} px:\n` +
      offenders.map((o) => `  ${o.description} — ${o.width} × ${o.height}`).join('\n'),
  ).toEqual([]);
}

/** Exactly one `h1` per document. */
export async function expectSingleH1(page: Page): Promise<void> {
  const texts = await page.locator('h1').allTextContents();
  expect(texts, `Erwartet genau eine h1, gefunden: ${JSON.stringify(texts)}`).toHaveLength(1);
}

/** Every visible form control carries a non-empty accessible name. */
export async function expectEveryInputHasAccessibleName(page: Page): Promise<void> {
  const controls = page.locator('input:not([type="hidden"]), select, textarea');
  const count = await controls.count();
  expect(count, 'Es wurde kein Formularfeld gefunden.').toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    /* The honeypot is removed from the accessibility tree on purpose. */
    const hidden = await control.evaluate((el) => el.closest('[aria-hidden="true"]') !== null);
    if (hidden) continue;
    await expect(control, `Feld ${index} hat keinen zugänglichen Namen.`).toHaveAccessibleName(
      /\S/,
    );
  }
}

export interface FocusReport {
  description: string;
  outlineWidth: string;
  outlineStyle: string;
  boxShadow: string;
  visible: boolean;
}

/**
 * Tabs through the first `steps` focusable elements and requires each of them
 * to paint a focus indicator.
 *
 * Keyboard focus rather than `element.focus()`: the styles sit behind
 * `:focus-visible`, which a programmatic focus call does not reliably match, so
 * a test that focused programmatically would pass against a page with no
 * keyboard affordance at all.
 */
export async function expectFocusVisibleWhileTabbing(page: Page, steps = 6): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const reports: FocusReport[] = [];
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press('Tab');
    const report: FocusReport | null = await page.evaluate(() => {
      function describe(el: Element): string {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
        return `${tag}${id}${text ? ` — "${text}"` : ''}`;
      }

      const el = document.activeElement;
      if (!el || el === document.body) return null;

      /* The indicator may be painted on the wrapping label rather than on the
         20 px control itself — that is the pattern the choice cards use, and it
         is the box the visitor actually sees light up. */
      const painted = [el, el.closest('label')].filter(
        (candidate): candidate is Element => candidate !== null,
      );
      const styles = painted.map((candidate) => getComputedStyle(candidate));
      const hasOutline = styles.some(
        (style) => style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0,
      );
      const hasShadow = styles.some(
        (style) => style.boxShadow !== 'none' && style.boxShadow.trim().length > 0,
      );
      const own = styles[0]!;
      return {
        description: describe(el),
        outlineWidth: own.outlineWidth,
        outlineStyle: own.outlineStyle,
        boxShadow: own.boxShadow,
        visible: hasOutline || hasShadow,
      };
    });
    if (report) reports.push(report);
  }

  expect(reports.length, 'Es war kein Element per Tastatur fokussierbar.').toBeGreaterThan(0);
  const invisible = reports.filter((report) => !report.visible);
  expect(
    invisible,
    'Fokus ohne sichtbare Markierung:\n' +
      invisible
        .map((r) => `  ${r.description} — outline ${r.outlineStyle} ${r.outlineWidth}`)
        .join('\n'),
  ).toEqual([]);
}

/** The field the keyboard focus currently sits in, by its spec field id. */
export async function focusedFieldId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return el.closest('[data-field]')?.getAttribute('data-field') ?? el.id ?? null;
  });
}
