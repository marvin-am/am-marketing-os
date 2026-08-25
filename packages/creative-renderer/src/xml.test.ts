import { describe, expect, it } from 'vitest';
import {
  assertWellFormedSvg,
  attr,
  escapeXml,
  findElements,
  normalizeWhitespace,
  parseXml,
  XmlWellFormednessError,
} from './xml';

describe('escapeXml', () => {
  it('escapes every character that can break out of markup', () => {
    expect(escapeXml('Preis & Leistung')).toBe('Preis &amp; Leistung');
    expect(escapeXml('<script>')).toBe('&lt;script&gt;');
    expect(escapeXml('sagte "ja"')).toBe('sagte &quot;ja&quot;');
    expect(escapeXml("O'Brien")).toBe('O&apos;Brien');
  });

  it('escapes an ampersand before anything else, so entities are not doubled', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('keeps German characters intact', () => {
    expect(escapeXml('Größe: 30 % über Maß')).toBe('Größe: 30 % über Maß');
  });

  it('replaces control characters that are illegal in XML', () => {
    expect(escapeXml('A\u0007B\u0000C')).toBe('A B C');
  });

  it('produces attributes that survive a round trip', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text ${attr('data-copy', 'A & B <c>')}>x</text></svg>`;
    const root = assertWellFormedSvg(svg);
    expect(findElements(root, 'text')[0]?.attributes['data-copy']).toBe('A &amp; B &lt;c&gt;');
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs and trims', () => {
    expect(normalizeWhitespace('  a \n b\t\tc  ')).toBe('a b c');
  });
});

describe('parseXml', () => {
  it('parses nested elements, attributes and text', () => {
    const root = parseXml('<svg width="10"><g><text x="1">Hallo</text></g><rect/></svg>');
    expect(root.name).toBe('svg');
    expect(root.attributes.width).toBe('10');
    expect(root.children).toHaveLength(2);
    expect(findElements(root, 'text')[0]?.text).toBe('Hallo');
  });

  it('skips the XML declaration and comments', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><svg><!-- inner --></svg>');
    expect(root.name).toBe('svg');
  });

  it('rejects a raw ampersand in text', () => {
    expect(() => parseXml('<svg><text>A & B</text></svg>')).toThrow(XmlWellFormednessError);
  });

  it('accepts a properly escaped ampersand', () => {
    expect(parseXml('<svg><text>A &amp; B</text></svg>').name).toBe('svg');
  });

  it('rejects a raw angle bracket in text', () => {
    expect(() => parseXml('<svg><text>a < b</text></svg>')).toThrow(XmlWellFormednessError);
  });

  it('rejects mismatched, unclosed and unquoted markup', () => {
    expect(() => parseXml('<svg><text></rect></svg>')).toThrow(/does not match/);
    expect(() => parseXml('<svg><text>x</text>')).toThrow(/Unclosed/);
    expect(() => parseXml('<svg width=10></svg>')).toThrow(/not quoted/);
    expect(() => parseXml('<svg/><svg/>')).toThrow(/More than one root/);
  });

  it('rejects a document whose root is not an svg element', () => {
    expect(() => assertWellFormedSvg('<html></html>')).toThrow(/expected "svg"/);
  });
});
