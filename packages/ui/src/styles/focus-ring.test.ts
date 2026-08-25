import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Every keyboard-focusable component in this package must actually paint a
 * focus ring (WCAG 2.4.7).
 *
 * The failure this guards against is a cascade problem, not a rendering one.
 * Tailwind v4 compiles `outline-2` to `outline-style: var(--tw-outline-style);
 * outline-width: 2px`, and `outline-none` / `outline-hidden` set that same
 * variable to `none` on the element. A class list carrying both therefore
 * resolves to `outline-style: none`, the width collapses to `0px`, and nothing
 * is drawn — while the class list still reads as though a ring were declared.
 * Tailwind v3 compiled `outline-none` to a transparent 2px outline, which
 * supplied the style the width utility was missing, so the same class list was
 * correct there and is silently inert here.
 *
 * Three ways to pin that down, and why this is the one:
 *
 *   - `getComputedStyle` in a jsdom test cannot see it. jsdom neither
 *     substitutes custom properties nor matches `:focus-visible`, so every
 *     assertion would pass on both the broken and the fixed class list. A test
 *     that cannot fail is worse than no test.
 *   - A Playwright run against the built console does see it, and is how the
 *     fix was verified — but it needs a production build and two servers, and
 *     it only covers the controls a spec happens to tab to.
 *   - Compiling the package's own stylesheet covers *every* focus-ring class
 *     list in `components/` in one pass, in the ordinary unit run, with no
 *     browser. It is the same compiler the apps use, so the declarations it
 *     emits are the declarations that ship.
 *
 * Since the cascade is read out of the compiler's output rather than out of a
 * browser, `resolveFocusRing` below is the part that could quietly stop
 * working. The last test in this file is its control: it feeds the resolver
 * the exact class list that shipped before this was fixed and asserts it comes
 * back unpainted. If the resolver ever degrades into something that always
 * reports a ring, that test fails.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
/*
 * Both apps are scanned, not just this package. Four controls in the console
 * carried the same cancelling pair and were missed by a sweep that stopped at
 * the design system — the mistake is a Tailwind idiom, so it turns up wherever
 * someone writes a class list, not only where the shared components live.
 */
const SCAN_DIRS = [
  resolve(HERE, '../components'),
  resolve(REPO, 'apps/console/src'),
  resolve(REPO, 'apps/funnels/src'),
];
const THEME_CSS = join(HERE, 'theme.css');

const require = createRequire(import.meta.url);

/** A class list lifted verbatim from a component source file. */
interface FocusRingSite {
  file: string;
  classList: string;
}

/**
 * Every string literal in `components/` that declares a focus ring.
 *
 * Reading the sources rather than listing components by hand is deliberate: a
 * component added next year is covered without anyone remembering to add it.
 */
function focusRingSites(): FocusRingSite[] {
  const sites: FocusRingSite[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      // `command.tsx` uses NUL as a join separator in a couple of string
      // literals; it is valid source but not something the matcher should see.
      const source = readFileSync(path, 'utf8').replaceAll('\0', '');
      for (const [, classList] of source.matchAll(/'([^'\n]*focus-visible:outline-2[^'\n]*)'/g)) {
        sites.push({ file: relative(REPO, path), classList });
      }
      // Class lists written directly in JSX rather than in a string literal.
      for (const [, classList] of source.matchAll(
        /className="([^"\n]*focus-visible:outline-2[^"\n]*)"/g,
      )) {
        sites.push({ file: relative(REPO, path), classList });
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(dir);
  return sites;
}

/* -------------------------------------------------------------------------- */
/* Reading declarations back out of the compiled stylesheet                    */
/* -------------------------------------------------------------------------- */

interface CssRule {
  selector: string;
  declarations: Map<string, string>;
}

function closingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

/** Top-level `property: value` pairs, ignoring anything in a nested block. */
function declarationsOf(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i += 1) {
    const ch = body[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth !== 0 || (ch !== ';' && i !== body.length)) continue;
    const chunk = body.slice(start, i).trim();
    start = i + 1;
    if (chunk === '' || chunk.includes('{')) continue;
    const colon = chunk.indexOf(':');
    if (colon === -1) continue;
    declarations.set(chunk.slice(0, colon).trim(), chunk.slice(colon + 1).trim());
  }
  return declarations;
}

/** Flattens `@layer` / `@media` wrappers so style rules come out in source order. */
function styleRules(css: string, into: CssRule[] = []): CssRule[] {
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) break;
    const prelude = css
      .slice(index, open)
      .trim()
      .replace(/^[;}]+/, '')
      .trim();
    const close = closingBrace(css, open);
    const body = css.slice(open + 1, close);
    if (prelude.startsWith('@')) {
      if (/^@(layer|media|supports)\b/.test(prelude)) styleRules(body, into);
    } else if (prelude !== '') {
      into.push({ selector: prelude, declarations: declarationsOf(body) });
    }
    index = close + 1;
  }
  return into;
}

/** `.focus-visible\:outline-2:focus-visible` → `focus-visible:outline-2` + `:focus-visible`. */
function splitSelector(selector: string): { className: string; state: string } | null {
  if (!selector.startsWith('.')) return null;
  let className = '';
  let i = 1;
  for (; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '\\') {
      i += 1;
      className += selector[i];
      continue;
    }
    if (ch === ':' || ch === '[' || ch === ' ' || ch === '>' || ch === ',') break;
    className += ch;
  }
  return { className, state: selector.slice(i) };
}

interface ResolvedRing {
  outlineStyle: string;
  outlineWidth: string;
}

/**
 * What an element carrying `classList` computes to while `:focus-visible`
 * matches.
 *
 * Only two states are considered — the bare class and `:focus-visible` — and
 * the latter wins, which is both what the cascade does (a compound selector
 * outranks a lone class) and the only distinction this defect turns on. A
 * width is reported as `0px` when the style resolves to `none`, the way a
 * browser collapses it.
 */
function resolveFocusRing(classList: string, css: string): ResolvedRing {
  const classes = new Set(classList.split(/\s+/).filter(Boolean));
  const initialOutlineStyle =
    /@property\s+--tw-outline-style\s*\{[^}]*initial-value:\s*([^;]+);/.exec(css)?.[1].trim() ??
    'none';

  const base = new Map<string, string>();
  const focusVisible = new Map<string, string>();
  for (const rule of styleRules(css)) {
    const parts = splitSelector(rule.selector);
    if (!parts || !classes.has(parts.className)) continue;
    const target =
      parts.state === '' ? base : parts.state === ':focus-visible' ? focusVisible : null;
    if (!target) continue;
    for (const [property, value] of rule.declarations) target.set(property, value);
  }

  const outlineStyleVariable =
    focusVisible.get('--tw-outline-style') ?? base.get('--tw-outline-style') ?? initialOutlineStyle;
  const substitute = (value: string): string =>
    value.replace('var(--tw-outline-style)', outlineStyleVariable);

  const outlineStyle = substitute(
    focusVisible.get('outline-style') ?? base.get('outline-style') ?? 'none',
  );
  const declaredWidth = focusVisible.get('outline-width') ?? base.get('outline-width') ?? '0px';
  return { outlineStyle, outlineWidth: outlineStyle === 'none' ? '0px' : declaredWidth };
}

/* -------------------------------------------------------------------------- */

const sites = focusRingSites();
let stylesheet = '';

beforeAll(async () => {
  const compiler = await compile(readFileSync(THEME_CSS, 'utf8'), {
    base: HERE,
    loadStylesheet: async (id, base) => {
      const path = id.startsWith('.')
        ? resolve(base, id)
        : require.resolve(id === 'tailwindcss' ? 'tailwindcss/index.css' : id);
      return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
    },
  });
  stylesheet = compiler.build([
    ...sites.flatMap((site) => site.classList.split(/\s+/)),
    ...BROKEN_CLASS_LIST.split(/\s+/),
  ]);
});

/** The class list every control in this package carried before the fix. */
const BROKEN_CLASS_LIST =
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

describe('focus ring', () => {
  it('finds the focus-ring class lists in the component sources', () => {
    // A regex that silently stops matching would turn every case below into a
    // vacuous pass, so the count itself is asserted.
    expect(sites.length).toBeGreaterThanOrEqual(30);
    expect(new Set(sites.map((site) => site.file)).size).toBeGreaterThanOrEqual(20);
    // Both apps, not only the design system: the four sites that slipped
    // through were in the console.
    for (const prefix of ['packages/ui', 'apps/console']) {
      expect(sites.some((site) => site.file.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it.each(sites.map((site) => [`${site.file}: ${site.classList}`, site.classList] as const))(
    'paints a ring for %s',
    (_name, classList) => {
      const { outlineStyle, outlineWidth } = resolveFocusRing(classList, stylesheet);

      expect(outlineStyle).not.toBe('none');
      expect(outlineWidth).not.toBe('0px');
    },
  );

  // The control for the resolver above. `outline-none` sets
  // `--tw-outline-style: none` and `outline-2` reads its style back out of
  // that variable, so this class list is inert however plausible it reads.
  it('reports no ring for a class list that suppresses the outline', () => {
    const { outlineStyle, outlineWidth } = resolveFocusRing(BROKEN_CLASS_LIST, stylesheet);

    expect(outlineStyle).toBe('none');
    expect(outlineWidth).toBe('0px');
  });
});
