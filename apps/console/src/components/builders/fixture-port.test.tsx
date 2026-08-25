import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_IDS, validateFormSpec, type MultiStepFormSpec } from '@am/funnel-schema';
import { FIXTURE_DRAFT_IDS, fixtureBuilderPort, resetFixtureBuilderStore } from './fixture-port';
import { issuesFor, pathMentions } from './issues';

/**
 * The port contract the components rely on, checked against the fixture
 * implementation the routes ship with: published versions are immutable, an
 * invalid spec is never stored, and restoring produces a new draft.
 *
 * The real repository has to satisfy exactly these expectations, so this file
 * doubles as the specification for that swap.
 */

describe('fixtureBuilderPort', () => {
  beforeEach(() => {
    resetFixtureBuilderStore();
  });

  it('lädt die veröffentlichte Formularversion schreibgeschützt', async () => {
    const record = await fixtureBuilderPort.loadFormVersion(FIXTURE_IDS.formVersionId);
    expect(record?.published).toBe(true);
    expect(validateFormSpec(record!.spec)).toHaveLength(0);
  });

  it('verweigert das Überschreiben einer veröffentlichten Version auf Deutsch', async () => {
    const record = await fixtureBuilderPort.loadFormVersion(FIXTURE_IDS.formVersionId);
    const result = await fixtureBuilderPort.saveFormDraft(FIXTURE_IDS.formVersionId, record!.spec);

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.code).toBe('VERSION_IMMUTABLE');
    expect(result.messageDe).toContain('Als neuen Entwurf bearbeiten');
  });

  it('erzeugt beim Duplizieren eine neue Entwurfsversion mit eigener Kennung', async () => {
    const duplicated = await fixtureBuilderPort.duplicateFormVersion(FIXTURE_IDS.formVersionId);
    expect(duplicated.status).toBe('ok');
    if (duplicated.status !== 'ok') return;

    const copy = await fixtureBuilderPort.loadFormVersion(duplicated.data.versionId);
    expect(copy?.published).toBe(false);
    expect(copy?.spec.formVersionId).toBe(duplicated.data.versionId);
    expect(copy?.version).toBeGreaterThan(1);

    /* The published original is untouched. */
    const original = await fixtureBuilderPort.loadFormVersion(FIXTURE_IDS.formVersionId);
    expect(original?.published).toBe(true);
    expect(original?.spec.formVersionId).toBe(FIXTURE_IDS.formVersionId);
  });

  it('speichert keine Spezifikation, die die Validierung blockiert', async () => {
    const record = await fixtureBuilderPort.loadFormVersion(FIXTURE_DRAFT_IDS.formVersionId);
    const broken: MultiStepFormSpec = {
      ...record!.spec,
      steps: record!.spec.steps.map((step) =>
        step.stepId === 'standort'
          ? { ...step, defaultNext: { kind: 'STEP' as const, stepId: 'gibt_es_nicht' } }
          : step,
      ),
    };

    const result = await fixtureBuilderPort.saveFormDraft(
      FIXTURE_DRAFT_IDS.formVersionId,
      broken,
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.messageDe).toContain('Fehler');
  });

  it('stellt eine ältere Version als neuen Entwurf wieder her', async () => {
    const versions = await fixtureBuilderPort.listFormVersions(FIXTURE_DRAFT_IDS.formVersionId);
    expect(versions.map((entry) => entry.labelDe)).toContain('Veröffentlicht v1');

    const restored = await fixtureBuilderPort.restoreFormVersion(
      FIXTURE_DRAFT_IDS.formVersionId,
      FIXTURE_IDS.formVersionId,
    );
    expect(restored.status).toBe('ok');
    if (restored.status !== 'ok') return;

    const record = await fixtureBuilderPort.loadFormVersion(restored.data.versionId);
    expect(record?.published).toBe(false);
    expect(restored.data.versionId).not.toBe(FIXTURE_IDS.formVersionId);
  });

  it('liefert nur tatsächlich vorhandene Einwilligungsversionen und Formulare', async () => {
    const consentTexts = await fixtureBuilderPort.listConsentTexts();
    expect(consentTexts).toHaveLength(1);
    expect(consentTexts[0]?.textDe.length).toBeGreaterThan(20);

    const forms = await fixtureBuilderPort.listPublishedForms();
    expect(forms.every((entry) => entry.formVersionId.length > 0)).toBe(true);
    expect(forms.map((entry) => entry.formVersionId)).toContain(FIXTURE_IDS.formVersionId);
  });
});

describe('Zuordnung von Validierungsmeldungen', () => {
  it('trennt ähnliche Kennungen sauber voneinander', () => {
    expect(pathMentions('Schritt „Titel“ (frage_1)', 'frage_1')).toBe(true);
    expect(pathMentions('Schritt „Titel“ (frage_10)', 'frage_1')).toBe(false);
    expect(pathMentions('steps.10.title', 'steps.1')).toBe(false);
  });

  it('findet die Hinweise, die zu einem Element gehören', () => {
    const issues = [
      {
        code: 'UNKNOWN_STEP_TARGET' as const,
        severity: 'ERROR' as const,
        pathDe: 'Schritt „Kontakt“ (kontakt) → Standardübergang',
        messageDe: 'Der Übergang zeigt ins Leere.',
      },
      {
        code: 'EMPTY_LABEL' as const,
        severity: 'ERROR' as const,
        pathDe: 'Feld „“ (vorname)',
        messageDe: 'Jedes Feld benötigt eine sichtbare Beschriftung.',
      },
    ];

    expect(issuesFor(issues, 'kontakt')).toHaveLength(1);
    expect(issuesFor(issues, 'vorname')[0]?.code).toBe('EMPTY_LABEL');
    expect(issuesFor(issues, 'unbekannt')).toHaveLength(0);
  });
});
