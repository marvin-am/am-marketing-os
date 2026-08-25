/**
 * `@am/funnel-schema` — the PageSpec / MultiStepFormSpec contract.
 *
 * One package owns the shape of every funnel document, the rules that decide
 * whether such a document may be published, and the engine that interprets it at
 * runtime. The console builder, the public funnel runtime, the AI pipeline and
 * the E2E suite all import from here, which is what keeps a preview, a published
 * page and a server-side submission from ever disagreeing.
 *
 * ```ts
 * const spec = buildDefaultMultiStepForm({ … });
 * const issues = validateFormSpec(spec);
 * if (!hasBlockingIssues(issues)) publish(spec);
 *
 * const target = nextTarget(spec, 'frage_1', answers);
 * const qualification = evaluateQualification(spec, answers);
 * const variant = selectResultVariant(spec, answers, qualification);
 * ```
 *
 * The package is pure logic: no React, no DOM, no I/O.
 */

export * from './common';
export * from './form-spec';
export * from './page-spec';
export * from './validate';
export * from './evaluate';
export * from './generate';
export * from './fixtures';
