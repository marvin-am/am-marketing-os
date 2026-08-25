import { newId } from '@am/domain';
import {
  errorsOf,
  hasBlockingIssues,
  validateFormSpec,
  validateHybridSpec,
  validatePageSpec,
  FIXTURE_IDS,
  HYBRID_FUNNEL_SPEC,
  LANDING_PAGE_SPEC,
  POTENZIALANALYSE_FORM_SPEC,
  type MultiStepFormSpec,
  type ValidationIssue,
} from '@am/funnel-schema';
import { actionError, actionOk, type ActionResult } from '@/lib/action-result';
import type {
  BuilderPort,
  ConsentTextOption,
  FormChoice,
  FormVersionRecord,
  PageDocumentSpec,
  PageVersionRecord,
  SavedVersion,
  VersionSummary,
} from './port';

/**
 * In-memory `BuilderPort` backed by the `@am/funnel-schema` fixtures.
 *
 * This exists so the builder routes work end to end **today**, before the
 * funnel repository lands. It is a fixture, and it behaves like one: state
 * lives in module scope and is lost when the server process restarts. It is not
 * a cache, not a queue and not a stand-in for a database — the lead swaps in the
 * real repository by implementing `BuilderPort` and passing it to the routes.
 *
 * What it does model faithfully, because the UI depends on it:
 *
 * - a published version refuses every write and can only be duplicated,
 * - a spec with blocking validation issues is never stored,
 * - restoring an old version creates a **new draft** rather than moving history.
 */

/* Stable draft ids in the fixture family, so links stay valid across restarts. */
export const FIXTURE_DRAFT_IDS = {
  formVersionId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6b01',
  landingPageVersionId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6b02',
  hybridPageVersionId: '7f1d3c2a-5b64-4a19-9e2f-1c0b8d4e6b03',
} as const;

const SEED_TIMESTAMP = '2026-08-01T09:00:00.000Z';

interface StoredVersion<TSpec> {
  versionId: string;
  documentId: string;
  version: number;
  published: boolean;
  updatedAt: string;
  spec: TSpec;
}

function cloneSpec<T>(spec: T): T {
  return structuredClone(spec);
}

function draftFormSpec(spec: MultiStepFormSpec, versionId: string): MultiStepFormSpec {
  return { ...cloneSpec(spec), formVersionId: versionId };
}

function draftPageSpec(spec: PageDocumentSpec, versionId: string): PageDocumentSpec {
  return { ...cloneSpec(spec), pageVersionId: versionId };
}

function seedForms(): Map<string, StoredVersion<MultiStepFormSpec>> {
  const published: StoredVersion<MultiStepFormSpec> = {
    versionId: FIXTURE_IDS.formVersionId,
    documentId: POTENZIALANALYSE_FORM_SPEC.formId,
    version: 1,
    published: true,
    updatedAt: SEED_TIMESTAMP,
    spec: cloneSpec(POTENZIALANALYSE_FORM_SPEC),
  };
  const draft: StoredVersion<MultiStepFormSpec> = {
    versionId: FIXTURE_DRAFT_IDS.formVersionId,
    documentId: POTENZIALANALYSE_FORM_SPEC.formId,
    version: 2,
    published: false,
    updatedAt: SEED_TIMESTAMP,
    spec: draftFormSpec(POTENZIALANALYSE_FORM_SPEC, FIXTURE_DRAFT_IDS.formVersionId),
  };
  return new Map([
    [published.versionId, published],
    [draft.versionId, draft],
  ]);
}

function seedPages(): Map<string, StoredVersion<PageDocumentSpec>> {
  const entries: StoredVersion<PageDocumentSpec>[] = [
    {
      versionId: FIXTURE_IDS.landingPageVersionId,
      documentId: LANDING_PAGE_SPEC.pageId,
      version: 1,
      published: true,
      updatedAt: SEED_TIMESTAMP,
      spec: cloneSpec(LANDING_PAGE_SPEC),
    },
    {
      versionId: FIXTURE_DRAFT_IDS.landingPageVersionId,
      documentId: LANDING_PAGE_SPEC.pageId,
      version: 2,
      published: false,
      updatedAt: SEED_TIMESTAMP,
      spec: draftPageSpec(LANDING_PAGE_SPEC, FIXTURE_DRAFT_IDS.landingPageVersionId),
    },
    {
      versionId: FIXTURE_IDS.hybridPageVersionId,
      documentId: HYBRID_FUNNEL_SPEC.pageId,
      version: 1,
      published: true,
      updatedAt: SEED_TIMESTAMP,
      spec: cloneSpec(HYBRID_FUNNEL_SPEC),
    },
    {
      versionId: FIXTURE_DRAFT_IDS.hybridPageVersionId,
      documentId: HYBRID_FUNNEL_SPEC.pageId,
      version: 2,
      published: false,
      updatedAt: SEED_TIMESTAMP,
      spec: draftPageSpec(HYBRID_FUNNEL_SPEC, FIXTURE_DRAFT_IDS.hybridPageVersionId),
    },
  ];
  return new Map(entries.map((entry) => [entry.versionId, entry]));
}

let forms = seedForms();
let pages = seedPages();

/** Restores the seeded state. Used by tests and by the demo reset. */
export function resetFixtureBuilderStore(): void {
  forms = seedForms();
  pages = seedPages();
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

function notFound<T>(id: string): ActionResult<T> {
  return actionError<T>(
    'NOT_FOUND',
    `Die Version ${id} existiert nicht (mehr). Bitte laden Sie die Übersicht neu.`,
  );
}

function immutable<T>(): ActionResult<T> {
  return actionError<T>(
    'VERSION_IMMUTABLE',
    'Diese Version ist veröffentlicht und kann nicht überschrieben werden. ' +
      'Erstellen Sie über „Als neuen Entwurf bearbeiten“ eine neue Entwurfsversion.',
  );
}

function blocked<T>(issues: readonly ValidationIssue[]): ActionResult<T> {
  const errors = errorsOf(issues);
  const first = errors[0];
  return actionError<T>(
    'VALIDATION_FAILED',
    errors.length === 1
      ? `Ein Fehler verhindert das Speichern: ${first?.pathDe} — ${first?.messageDe}`
      : `${errors.length} Fehler verhindern das Speichern. Der erste: ${first?.pathDe} — ${first?.messageDe}`,
  );
}

function nextVersionNumber<T>(store: Map<string, StoredVersion<T>>, documentId: string): number {
  let highest = 0;
  for (const entry of store.values()) {
    if (entry.documentId === documentId) highest = Math.max(highest, entry.version);
  }
  return highest + 1;
}

function summarize<T>(store: Map<string, StoredVersion<T>>, documentId: string): VersionSummary[] {
  return [...store.values()]
    .filter((entry) => entry.documentId === documentId)
    .sort((a, b) => b.version - a.version)
    .map((entry) => ({
      versionId: entry.versionId,
      version: entry.version,
      published: entry.published,
      updatedAt: entry.updatedAt,
      labelDe: entry.published ? `Veröffentlicht v${entry.version}` : `Entwurf v${entry.version}`,
    }));
}

function validatePage(spec: PageDocumentSpec): ValidationIssue[] {
  return spec.kind === 'HYBRID' ? validateHybridSpec(spec) : validatePageSpec(spec);
}

/* -------------------------------------------------------------------------- */
/* Port                                                                        */
/* -------------------------------------------------------------------------- */

export const fixtureBuilderPort: BuilderPort = {
  async listConsentTexts(): Promise<ConsentTextOption[]> {
    /* Exactly the consent versions that exist. None are invented, so a form
       whose consent version is unknown here keeps the one it already carries. */
    const consent = POTENZIALANALYSE_FORM_SPEC.consent;
    return [
      {
        consentVersionId: consent.consentVersionId,
        labelDe: 'Standard-Einwilligung (Kontakt und Werbeerfolgsmessung)',
        textDe: consent.textDe,
        purposes: [...consent.purposes],
        privacyPolicyUrl: consent.privacyPolicyUrl,
      },
    ];
  },

  async listPublishedForms(): Promise<FormChoice[]> {
    return [...forms.values()]
      .filter((entry) => entry.published)
      .sort((a, b) => b.version - a.version)
      .map((entry) => ({
        formId: entry.spec.formId,
        formVersionId: entry.versionId,
        labelDe: `${entry.spec.title} — veröffentlicht v${entry.version}`,
      }));
  },

  async loadFormVersion(id: string): Promise<FormVersionRecord | null> {
    const entry = forms.get(id);
    if (!entry) return null;
    return { spec: cloneSpec(entry.spec), published: entry.published, version: entry.version };
  },

  async saveFormDraft(id, spec): Promise<ActionResult<SavedVersion>> {
    const entry = forms.get(id);
    if (!entry) return notFound(id);
    if (entry.published) return immutable();

    const issues = validateFormSpec(spec);
    if (hasBlockingIssues(issues)) return blocked(issues);

    entry.spec = { ...cloneSpec(spec), formVersionId: entry.versionId };
    entry.updatedAt = new Date().toISOString();
    return actionOk({ versionId: entry.versionId, version: entry.version });
  },

  async publishFormVersion(id, spec): Promise<ActionResult<{ versionId: string }>> {
    const entry = forms.get(id);
    if (!entry) return notFound(id);
    if (entry.published) return immutable();

    const issues = validateFormSpec(spec);
    if (hasBlockingIssues(issues)) return blocked(issues);

    entry.spec = { ...cloneSpec(spec), formVersionId: entry.versionId };
    entry.published = true;
    entry.updatedAt = new Date().toISOString();
    return actionOk({ versionId: entry.versionId });
  },

  async duplicateFormVersion(id): Promise<ActionResult<SavedVersion>> {
    const entry = forms.get(id);
    if (!entry) return notFound(id);

    const versionId = newId();
    const version = nextVersionNumber(forms, entry.documentId);
    forms.set(versionId, {
      versionId,
      documentId: entry.documentId,
      version,
      published: false,
      updatedAt: new Date().toISOString(),
      spec: draftFormSpec(entry.spec, versionId),
    });
    return actionOk({ versionId, version });
  },

  async listFormVersions(id): Promise<VersionSummary[]> {
    const entry = forms.get(id);
    if (!entry) return [];
    return summarize(forms, entry.documentId);
  },

  async restoreFormVersion(id, sourceVersionId): Promise<ActionResult<SavedVersion>> {
    const target = forms.get(id);
    const source = forms.get(sourceVersionId);
    if (!target || !source) return notFound(sourceVersionId);
    if (source.documentId !== target.documentId) {
      return actionError(
        'VALIDATION_FAILED',
        'Die gewählte Version gehört zu einem anderen Formular.',
      );
    }

    const versionId = newId();
    const version = nextVersionNumber(forms, target.documentId);
    forms.set(versionId, {
      versionId,
      documentId: target.documentId,
      version,
      published: false,
      updatedAt: new Date().toISOString(),
      spec: draftFormSpec(source.spec, versionId),
    });
    return actionOk({ versionId, version });
  },

  async loadPageVersion(id): Promise<PageVersionRecord | null> {
    const entry = pages.get(id);
    if (!entry) return null;
    return { spec: cloneSpec(entry.spec), published: entry.published, version: entry.version };
  },

  async savePageDraft(id, spec): Promise<ActionResult<SavedVersion>> {
    const entry = pages.get(id);
    if (!entry) return notFound(id);
    if (entry.published) return immutable();

    const issues = validatePage(spec);
    if (hasBlockingIssues(issues)) return blocked(issues);

    entry.spec = { ...cloneSpec(spec), pageVersionId: entry.versionId };
    entry.updatedAt = new Date().toISOString();
    return actionOk({ versionId: entry.versionId, version: entry.version });
  },

  async publishPageVersion(id, spec): Promise<ActionResult<{ versionId: string }>> {
    const entry = pages.get(id);
    if (!entry) return notFound(id);
    if (entry.published) return immutable();

    const issues = validatePage(spec);
    if (hasBlockingIssues(issues)) return blocked(issues);

    entry.spec = { ...cloneSpec(spec), pageVersionId: entry.versionId };
    entry.published = true;
    entry.updatedAt = new Date().toISOString();
    return actionOk({ versionId: entry.versionId });
  },

  async duplicatePageVersion(id): Promise<ActionResult<SavedVersion>> {
    const entry = pages.get(id);
    if (!entry) return notFound(id);

    const versionId = newId();
    const version = nextVersionNumber(pages, entry.documentId);
    pages.set(versionId, {
      versionId,
      documentId: entry.documentId,
      version,
      published: false,
      updatedAt: new Date().toISOString(),
      spec: draftPageSpec(entry.spec, versionId),
    });
    return actionOk({ versionId, version });
  },

  async listPageVersions(id): Promise<VersionSummary[]> {
    const entry = pages.get(id);
    if (!entry) return [];
    return summarize(pages, entry.documentId);
  },

  async restorePageVersion(id, sourceVersionId): Promise<ActionResult<SavedVersion>> {
    const target = pages.get(id);
    const source = pages.get(sourceVersionId);
    if (!target || !source) return notFound(sourceVersionId);
    if (source.documentId !== target.documentId) {
      return actionError('VALIDATION_FAILED', 'Die gewählte Version gehört zu einer anderen Seite.');
    }

    const versionId = newId();
    const version = nextVersionNumber(pages, target.documentId);
    pages.set(versionId, {
      versionId,
      documentId: target.documentId,
      version,
      published: false,
      updatedAt: new Date().toISOString(),
      spec: draftPageSpec(source.spec, versionId),
    });
    return actionOk({ versionId, version });
  },
};
