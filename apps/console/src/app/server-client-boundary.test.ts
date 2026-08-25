import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * No server component may read a `'use client'` module's exports as values.
 *
 * A `'use client'` module does not reach a server component as itself. The
 * bundler replaces every one of its exports with a client reference — a marker
 * the renderer turns into a browser import. That is exactly right for a
 * component, which the server only ever places into the tree by name. It is
 * silently wrong for a plain value: a server component that reads an array, a
 * record or a helper function out of such a module gets the marker instead.
 *
 * Both instances found so far show how differently that can present. On
 * `/einstellungen` a server component called `.includes()` on a tab list and
 * the route 500'd on every request, taking six surfaces that deep-link into it
 * down as well. In the analytics charts a server component read
 * `VIZ_SERIES[index % VIZ_SERIES.length]`, where `.length` on a reference is
 * `undefined`, `index % undefined` is `NaN`, and a colour swatch simply
 * rendered blank — no error anywhere. The loud one was found by a person
 * clicking; the quiet one only by reading the module graph.
 *
 * Which is why this is a static check and not a render test. The mistake is
 * invisible to `tsc`, because the types are perfectly sound and only the
 * runtime value is not. It is invisible to a component test, because
 * `@testing-library` imports the real module and gets the real array — the
 * substitution happens only in a Next.js build. And a render test proves one
 * page works today, whereas the graph rules the mistake out for every module
 * every route reaches, including ones added later.
 */

const APP = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(APP, '..');
/* The route the first instance was found in; the guard tests below use it as a
   known-shaped example rather than as the scope. */
const SETTINGS = resolve(APP, '(app)', 'einstellungen');
const ROOTS = [APP];

/* -------------------------------------------------------------------------- */
/* Analysis                                                                    */
/* -------------------------------------------------------------------------- */

function parse(file: string, source = readFileSync(file, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** True when the module opens with the given directive prologue. */
function hasDirective(sourceFile: ts.SourceFile, directive: string): boolean {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteralLike(statement.expression)) {
      return false;
    }
    if (statement.expression.text === directive) return true;
  }
  return false;
}

/** Mirrors the bundler's resolution for the two forms used inside the app. */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null;

  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface ResolvedImport {
  target: string;
  /** Local names bound to a value. Type-only imports are erased and cannot bite. */
  valueLocals: string[];
}

function importsOf(file: string, sourceFile: ts.SourceFile): ResolvedImport[] {
  const found: ResolvedImport[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    const target = resolveImport(file, statement.moduleSpecifier.text);
    if (!target) continue;

    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) {
      found.push({ target, valueLocals: [] });
      continue;
    }

    const valueLocals: string[] = [];
    if (clause.name) valueLocals.push(clause.name.text);
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        valueLocals.push(clause.namedBindings.name.text);
      } else {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly) valueLocals.push(element.name.text);
        }
      }
    }
    found.push({ target, valueLocals });
  }
  return found;
}

function isInTypePosition(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent) || ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent)) return true;
    if (ts.isExpression(parent) || ts.isStatement(parent)) return false;
  }
  return false;
}

/**
 * True when the identifier is the tag of a JSX element, including the head of a
 * member tag such as `<Editor.Row />`. This is the one position in which a
 * client reference is what the server is supposed to hand back.
 */
function isJsxTagName(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) return false;
  return (
    (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) &&
    parent.tagName === current
  );
}

interface BoundaryViolation {
  file: string;
  line: number;
  name: string;
  snippet: string;
}

/**
 * Every use of a client-module binding that is not a JSX tag: a property read,
 * a call, an index, a spread. It takes the source as a string so the last two
 * tests can run it over a known-bad and a known-good page and prove the check
 * has teeth rather than passing vacuously.
 */
function clientValueUses(
  file: string,
  source: string,
  clientLocals: ReadonlySet<string>,
): BoundaryViolation[] {
  if (clientLocals.size === 0) return [];
  const sourceFile = parse(file, source);
  const violations: BoundaryViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && clientLocals.has(node.text)) {
      const parent = node.parent;
      const isBindingSite =
        ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
      const isPropertyName =
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isJsxAttribute(parent) && parent.name === node);

      if (!isBindingSite && !isPropertyName && !isInTypePosition(node) && !isJsxTagName(node)) {
        violations.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          name: node.text,
          snippet: parent.getText(sourceFile).split('\n')[0]!.trim().slice(0, 100),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return violations;
}

interface Graph {
  serverModules: string[];
  clientModules: string[];
  violations: BoundaryViolation[];
}

/** Walks outward from the route's server files, stopping at every client module. */
function analyse(roots: readonly string[]): Graph {
  const seeds: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      // Recursive: a root is a route tree, and the segment that has the bug is
      // never the segment someone thought to list.
      if (statSync(path).isDirectory()) {
        collect(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      if (!hasDirective(parse(path), 'use client')) seeds.push(path);
    }
  };
  for (const root of roots) collect(root);

  const serverModules = new Set<string>();
  const clientModules = new Set<string>();
  const violations: BoundaryViolation[] = [];
  const queue = [...seeds];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (serverModules.has(file)) continue;
    serverModules.add(file);

    const source = readFileSync(file, 'utf8');
    const sourceFile = parse(file, source);
    const clientLocals = new Set<string>();

    for (const imported of importsOf(file, sourceFile)) {
      if (hasDirective(parse(imported.target), 'use client')) {
        clientModules.add(imported.target);
        for (const local of imported.valueLocals) clientLocals.add(local);
      } else if (!serverModules.has(imported.target)) {
        queue.push(imported.target);
      }
    }

    violations.push(...clientValueUses(file, source, clientLocals));
  }

  return {
    serverModules: [...serverModules].sort(),
    clientModules: [...clientModules].sort(),
    violations,
  };
}

/* -------------------------------------------------------------------------- */
/* The rule                                                                    */
/* -------------------------------------------------------------------------- */

describe('server/client boundary', () => {
  const graph = analyse(ROOTS);

  it('reaches the modules it claims to check', () => {
    // Without this the rule below could pass by inspecting nothing at all.
    expect(graph.serverModules).toContain(join(SETTINGS, 'page.tsx'));
    expect(graph.serverModules.length).toBeGreaterThan(1);
    expect(graph.clientModules).toContain(join(SRC, 'components', 'settings', 'settings-view.tsx'));
  });

  it('never reads a value out of a client module on the server', () => {
    const report = graph.violations.map(
      (violation) =>
        `${relative(SRC, violation.file)}:${violation.line} reads „${violation.name}“ from a 'use client' module (${violation.snippet}). ` +
        'Move the value into a module without the directive and import it from there; the server only ever receives a client reference for a component it renders.',
    );
    expect(report).toEqual([]);
  });

  it('flags the exact shape of the regression it exists for', () => {
    const bad = `
      import { SETTINGS_TABS, SettingsView, type SettingsTab } from '@/components/settings/settings-view';
      export default function Page({ tab }: { tab?: string }) {
        const defaultTab: SettingsTab = SETTINGS_TABS.includes(tab as SettingsTab) ? (tab as SettingsTab) : 'users';
        return <SettingsView defaultTab={defaultTab} />;
      }
    `;
    const found = clientValueUses(join(SETTINGS, 'page.tsx'), bad, new Set(['SETTINGS_TABS', 'SettingsView']));
    expect(found.map((violation) => violation.name)).toEqual(['SETTINGS_TABS']);
  });

  it('leaves a client component rendered by name alone', () => {
    const good = `
      import { SettingsView } from '@/components/settings/settings-view';
      import { resolveSettingsTab } from '@/components/settings/tabs';
      export default function Page({ tab }: { tab?: string }) {
        return <SettingsView defaultTab={resolveSettingsTab(tab)} />;
      }
    `;
    expect(clientValueUses(join(SETTINGS, 'page.tsx'), good, new Set(['SettingsView']))).toEqual([]);
  });
});
