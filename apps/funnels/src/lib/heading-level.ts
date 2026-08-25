/**
 * Heading levels for a runtime that is sometimes the document and sometimes a
 * section of one.
 *
 * A standalone multi-step form owns its page: the step title is what the page
 * is about, so it is the `h1`. The same runtime embedded in a landing or hybrid
 * page sits below that page's hero headline, and a second `h1` there costs the
 * document its outline — "jump to the top heading" stops meaning anything, and
 * the heading that changes on every answer competes with the offer for the role
 * of page title.
 *
 * Which component owns the `h1` is therefore a property of the page, not of the
 * component, and it is passed down rather than guessed.
 */

export type HeadingLevel = 1 | 2;

/** The tag for `level`, or for a heading nested `offset` levels below it. */
export function headingTag(level: HeadingLevel, offset: 0 | 1 = 0): 'h1' | 'h2' | 'h3' {
  return `h${level + offset}` as 'h1' | 'h2' | 'h3';
}
