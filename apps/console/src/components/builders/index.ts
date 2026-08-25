/**
 * The visual builders: multi-step forms, landing pages, hybrid funnels, and the
 * previews that render them with the shared `@am/funnel-schema` engine.
 *
 * The only thing that has to be wired from outside is `BuilderPort`. Everything
 * else — editing, validation, preview — is self-contained, and every mutation is
 * a pure function over a spec, so the builders never need a repository of their
 * own.
 */

export type {
  BuilderCommands,
  BuilderPort,
  ConsentTextOption,
  FormBuilderCommands,
  FormChoice,
  FormVersionRecord,
  PageBuilderCommands,
  PageDocumentSpec,
  PageVersionRecord,
  SavedVersion,
  VersionSummary,
} from './port';

/*
 * `fixtureBuilderPort` is deliberately **not** re-exported here. It holds
 * module-scoped state and belongs to the server side; importing it from a
 * client component would ship that state into the browser bundle. Routes and
 * server actions import it directly from `./fixture-port`.
 */

export { FormBuilder, type FormBuilderProps } from './form/form-builder';
export { PageBuilder, type PageBuilderProps } from './page/page-builder';
export { FormPreview, type FormPreviewProps } from './preview/form-preview';
export { PagePreview, type PagePreviewProps } from './preview/page-preview';
export { PathInspector } from './preview/path-inspector';
export { ViewportFrame, PREVIEW_VIEWPORTS } from './preview/viewport-frame';

export { issuesFor, issueSummaryTextDe, countIssues, worstSeverity } from './issues';
export { IssueSummaryPanel, InlineIssues, IssueMarker } from './issue-views';
export { deriveKey, deriveUniqueKey, uniqueKey } from './keys';
