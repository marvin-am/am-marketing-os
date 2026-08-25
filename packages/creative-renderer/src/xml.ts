/**
 * XML escaping and a strict well-formedness checker.
 *
 * Ad copy is operator- and model-authored text that ends up inside an SVG
 * document. An unescaped `&` or `<` is not a cosmetic problem: librsvg refuses
 * the whole document, and a crafted string could otherwise close a `<text>`
 * element and inject arbitrary SVG. Everything typographic therefore goes
 * through `escapeXml`, and every generated document is checked for
 * well-formedness before it is handed to the rasteriser.
 */

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Control characters that are illegal in XML 1.0 even when escaped as numeric
 * references. They are replaced by a space rather than dropped so that word
 * boundaries survive.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g;

/** Escapes text for use in XML character data *and* attribute values. */
export function escapeXml(value: string): string {
  return value
    .replace(ILLEGAL_XML_CHARS, ' ')
    .replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/** Collapses all whitespace runs to a single space and trims. */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Escapes a value that will be used as an XML attribute value. */
export function attr(name: string, value: string | number): string {
  return `${name}="${escapeXml(String(value))}"`;
}

/* -------------------------------------------------------------------------- */
/* Well-formedness check                                                       */
/* -------------------------------------------------------------------------- */

export interface XmlElementNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlElementNode[];
  text: string;
}

export class XmlWellFormednessError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} (Position ${position})`);
    this.name = 'XmlWellFormednessError';
    this.position = position;
  }
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;
const ENTITY = /^&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/;

function assertNoRawMarkup(text: string, offset: number): void {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '<') {
      throw new XmlWellFormednessError('Unescaped "<" in text content', offset + i);
    }
    if (char === '&') {
      if (!ENTITY.test(text.slice(i))) {
        throw new XmlWellFormednessError('Unescaped "&" in text content', offset + i);
      }
    }
  }
}

/**
 * Parses the subset of XML this package emits (elements, attributes, text and
 * comments) and throws on anything that is not well formed. This is a guard,
 * not a general purpose parser: it deliberately rejects DTDs, CDATA sections and
 * processing instructions other than the XML declaration, none of which we ever
 * produce.
 */
export function parseXml(source: string): XmlElementNode {
  let index = 0;
  const stack: XmlElementNode[] = [];
  let root: XmlElementNode | null = null;

  const skipDeclaration = (): void => {
    if (source.startsWith('<?xml', index)) {
      const end = source.indexOf('?>', index);
      if (end < 0) throw new XmlWellFormednessError('Unterminated XML declaration', index);
      index = end + 2;
    }
  };

  const readName = (): string => {
    const start = index;
    if (!NAME_START.test(source[index] ?? '')) {
      throw new XmlWellFormednessError('Invalid element or attribute name', index);
    }
    index++;
    while (index < source.length && NAME_CHAR.test(source[index]!)) index++;
    return source.slice(start, index);
  };

  const skipSpace = (): void => {
    while (index < source.length && /\s/.test(source[index]!)) index++;
  };

  const readAttributes = (): Record<string, string> => {
    const attributes: Record<string, string> = {};
    for (;;) {
      skipSpace();
      const char = source[index];
      if (char === undefined) throw new XmlWellFormednessError('Unterminated start tag', index);
      if (char === '>' || char === '/') return attributes;

      const name = readName();
      if (name in attributes) {
        throw new XmlWellFormednessError(`Duplicate attribute "${name}"`, index);
      }
      skipSpace();
      if (source[index] !== '=') {
        throw new XmlWellFormednessError(`Attribute "${name}" has no value`, index);
      }
      index++;
      skipSpace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") {
        throw new XmlWellFormednessError(`Attribute "${name}" value is not quoted`, index);
      }
      index++;
      const valueStart = index;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '<') {
          throw new XmlWellFormednessError(`Unescaped "<" in attribute "${name}"`, index);
        }
        if (source[index] === '&' && !ENTITY.test(source.slice(index))) {
          throw new XmlWellFormednessError(`Unescaped "&" in attribute "${name}"`, index);
        }
        index++;
      }
      if (index >= source.length) {
        throw new XmlWellFormednessError(`Unterminated attribute "${name}"`, valueStart);
      }
      attributes[name] = source.slice(valueStart, index);
      index++;
    }
  };

  skipSpace();
  skipDeclaration();

  while (index < source.length) {
    const nextTag = source.indexOf('<', index);
    if (nextTag < 0) {
      const trailing = source.slice(index);
      assertNoRawMarkup(trailing, index);
      if (trailing.trim().length > 0 && stack.length === 0) {
        throw new XmlWellFormednessError('Text outside of the root element', index);
      }
      index = source.length;
      break;
    }

    if (nextTag > index) {
      const text = source.slice(index, nextTag);
      assertNoRawMarkup(text, index);
      const current = stack[stack.length - 1];
      if (current) current.text += text;
      else if (text.trim().length > 0) {
        throw new XmlWellFormednessError('Text outside of the root element', index);
      }
      index = nextTag;
    }

    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end < 0) throw new XmlWellFormednessError('Unterminated comment', index);
      index = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', index) || source.startsWith('<!', index)) {
      throw new XmlWellFormednessError('Unsupported markup declaration', index);
    }

    if (source.startsWith('</', index)) {
      index += 2;
      const name = readName();
      skipSpace();
      if (source[index] !== '>') throw new XmlWellFormednessError('Unterminated end tag', index);
      index++;
      const open = stack.pop();
      if (!open) throw new XmlWellFormednessError(`Unexpected closing tag "${name}"`, index);
      if (open.name !== name) {
        throw new XmlWellFormednessError(
          `Closing tag "${name}" does not match open tag "${open.name}"`,
          index,
        );
      }
      continue;
    }

    index++;
    const name = readName();
    const attributes = readAttributes();
    const node: XmlElementNode = { name, attributes, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (root) throw new XmlWellFormednessError('More than one root element', index);
    else root = node;

    if (source[index] === '/') {
      index++;
      if (source[index] !== '>') throw new XmlWellFormednessError('Malformed empty tag', index);
      index++;
      continue;
    }
    if (source[index] !== '>') throw new XmlWellFormednessError('Unterminated start tag', index);
    index++;
    stack.push(node);
  }

  if (stack.length > 0) {
    throw new XmlWellFormednessError(`Unclosed element "${stack[stack.length - 1]!.name}"`, index);
  }
  if (!root) throw new XmlWellFormednessError('Document has no root element', 0);
  return root;
}

/** Depth-first walk over a parsed document. */
export function walkXml(node: XmlElementNode, visit: (node: XmlElementNode) => void): void {
  visit(node);
  for (const child of node.children) walkXml(child, visit);
}

/** Collects every element with the given tag name. */
export function findElements(node: XmlElementNode, name: string): XmlElementNode[] {
  const found: XmlElementNode[] = [];
  walkXml(node, (candidate) => {
    if (candidate.name === name) found.push(candidate);
  });
  return found;
}

/** Throws unless `source` is a well-formed SVG document. */
export function assertWellFormedSvg(source: string): XmlElementNode {
  const root = parseXml(source);
  if (root.name !== 'svg') {
    throw new XmlWellFormednessError(`Root element is "${root.name}", expected "svg"`, 0);
  }
  return root;
}
