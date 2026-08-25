import type { ConsentPurpose } from '@am/domain';
import type {
  HybridFunnelSpec,
  LandingPageSpec,
  MultiStepFormSpec,
} from '@am/funnel-schema';
import type { ActionResult } from '@/lib/action-result';

/**
 * The narrow data port the builders need.
 *
 * The visual builders own editing, validation and preview; they own no storage.
 * Everything they need from the data layer is declared here, so the repository
 * implementation can be swapped in without touching a single component. Until
 * that exists, `fixture-port.ts` implements this interface against the
 * `@am/funnel-schema` fixtures and the routes work end to end.
 *
 * Two invariants the implementation must uphold — the UI states both plainly
 * and the fixture implementation enforces both:
 *
 * 1. **A published version is immutable** (AGENTS.md rule 6). `saveFormDraft`
 *    and `savePageDraft` must refuse a published version; editing one goes
 *    through `duplicate…Version`, which creates a new draft.
 * 2. **A spec with blocking issues is never stored.** Validation lives in
 *    `@am/funnel-schema`; the port re-checks it because a client-side check is
 *    a convenience, not a guarantee.
 */

/** A landing page or a hybrid funnel — both are edited by the page builder. */
export type PageDocumentSpec = LandingPageSpec | HybridFunnelSpec;

export interface FormVersionRecord {
  spec: MultiStepFormSpec;
  published: boolean;
  version: number;
}

export interface PageVersionRecord {
  spec: PageDocumentSpec;
  published: boolean;
  version: number;
}

export interface VersionSummary {
  versionId: string;
  version: number;
  published: boolean;
  /** ISO-8601 UTC. */
  updatedAt: string;
  /** German one-liner shown in the version list, e.g. „Entwurf v3“. */
  labelDe: string;
}

export interface SavedVersion {
  versionId: string;
  version: number;
}

/**
 * A consent version an operator may pick. The wording itself is frozen: it is
 * the exact text visitors agreed to, so the builder offers a choice between
 * versions rather than a text field.
 */
export interface ConsentTextOption {
  consentVersionId: string;
  /** German label in the picker, e.g. „Standard-Einwilligung v2“. */
  labelDe: string;
  textDe: string;
  purposes: ConsentPurpose[];
  privacyPolicyUrl: string;
}

/** A published form version a page may embed. */
export interface FormChoice {
  formId: string;
  formVersionId: string;
  labelDe: string;
}

export interface BuilderPort {
  /* ---- catalogues the editors need ---- */
  listConsentTexts(): Promise<ConsentTextOption[]>;
  /** Published form versions an `EMBEDDED_CONTACT` block or a hybrid may point at. */
  listPublishedForms(): Promise<FormChoice[]>;

  /* ---- multi-step forms ---- */
  loadFormVersion(id: string): Promise<FormVersionRecord | null>;
  saveFormDraft(id: string, spec: MultiStepFormSpec): Promise<ActionResult<SavedVersion>>;
  publishFormVersion(
    id: string,
    spec: MultiStepFormSpec,
  ): Promise<ActionResult<{ versionId: string }>>;
  /** Creates a new draft from `id`. The only way to change a published version. */
  duplicateFormVersion(id: string): Promise<ActionResult<SavedVersion>>;
  listFormVersions(id: string): Promise<VersionSummary[]>;
  /** Creates a new draft from an earlier version of the same form. */
  restoreFormVersion(id: string, sourceVersionId: string): Promise<ActionResult<SavedVersion>>;

  /* ---- landing pages and hybrid funnels ---- */
  loadPageVersion(id: string): Promise<PageVersionRecord | null>;
  savePageDraft(id: string, spec: PageDocumentSpec): Promise<ActionResult<SavedVersion>>;
  publishPageVersion(
    id: string,
    spec: PageDocumentSpec,
  ): Promise<ActionResult<{ versionId: string }>>;
  duplicatePageVersion(id: string): Promise<ActionResult<SavedVersion>>;
  listPageVersions(id: string): Promise<VersionSummary[]>;
  restorePageVersion(id: string, sourceVersionId: string): Promise<ActionResult<SavedVersion>>;
}

/**
 * What a builder shell may do, independent of which document it edits.
 *
 * The route binds these to server actions; a test binds them to spies. Neither
 * the editor nor the preview ever imports a port implementation directly.
 */
export interface BuilderCommands<TSpec> {
  save(spec: TSpec): Promise<ActionResult<SavedVersion>>;
  publish(spec: TSpec): Promise<ActionResult<{ versionId: string }>>;
  /** Copies the open version into a fresh draft and returns its id. */
  duplicate(): Promise<ActionResult<SavedVersion>>;
  restore(sourceVersionId: string): Promise<ActionResult<SavedVersion>>;
}

export type FormBuilderCommands = BuilderCommands<MultiStepFormSpec>;
export type PageBuilderCommands = BuilderCommands<PageDocumentSpec>;
