'use client';

import * as React from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import {
  getStep,
  hasBlockingIssues,
  validateFormSpec,
  type MultiStepFormSpec,
} from '@am/funnel-schema';
import { cn, Badge, Button, ConfirmDialog } from '@am/ui';
import { issueSummaryTextDe, issuesFor, stepTokens } from '../issues';
import { IssueMarker, IssueSummaryPanel } from '../issue-views';
import { STEP_KIND_LABELS_DE } from '../labels';
import { OrderableList } from '../orderable';
import type { ConsentTextOption } from './content-editor';
import type { FormBuilderCommands, VersionSummary } from '../port';
import { FormPreview } from '../preview/form-preview';
import { VersionBar } from '../version-bar';
import { ConsentSubmitEditor, IntroEditor } from './content-editor';
import { QualificationEditor } from './qualification-editor';
import { ResultEditor } from './result-editor';
import { StepEditor } from './step-editor';
import {
  addStep,
  deleteStep,
  duplicateStep,
  moveStep,
  stepDeletionImpact,
  LIMITS,
} from './form-ops';

/**
 * The multi-step form builder.
 *
 * Three panes on a wide screen — steps, the open step, the live preview — and
 * the same three as switchable panes below `md`, because the editor is used on a
 * laptop far more often than on a phone but must not become unusable there.
 *
 * The spec is held as one immutable document. Every edit goes through a pure
 * operation in `form-ops`, every render revalidates with `validateFormSpec`, and
 * the resulting issues are handed down to the pane that owns the offending
 * element. There is no second source of truth about what is valid, and no way to
 * reach the underlying JSON from the interface.
 */

type Selection =
  | { kind: 'intro' }
  | { kind: 'step'; stepId: string }
  | { kind: 'qualification' }
  | { kind: 'results' }
  | { kind: 'consent' };

type Pane = 'structure' | 'editor' | 'preview';

export interface FormBuilderProps {
  initialSpec: MultiStepFormSpec;
  version: number;
  published: boolean;
  versions: readonly VersionSummary[];
  consentTexts: readonly ConsentTextOption[];
  commands: FormBuilderCommands;
  onOpenVersion: (versionId: string) => void;
}

export function FormBuilder({
  initialSpec,
  version,
  published,
  versions,
  consentTexts,
  commands,
  onOpenVersion,
}: FormBuilderProps) {
  const [spec, setSpec] = React.useState(initialSpec);
  const [dirty, setDirty] = React.useState(false);
  const [selection, setSelection] = React.useState<Selection>(() =>
    initialSpec.steps[0]
      ? { kind: 'step', stepId: initialSpec.steps[0].stepId }
      : { kind: 'intro' },
  );
  const [pane, setPane] = React.useState<Pane>('editor');
  const [pendingStepDelete, setPendingStepDelete] = React.useState<string | null>(null);

  const issues = React.useMemo(() => validateFormSpec(spec), [spec]);
  const blocking = hasBlockingIssues(issues);
  const disabled = published;

  const update = (next: MultiStepFormSpec) => {
    setSpec(next);
    setDirty(true);
  };

  const selectedStep = selection.kind === 'step' ? getStep(spec, selection.stepId) : null;
  const impact = pendingStepDelete ? stepDeletionImpact(spec, pendingStepDelete) : null;

  const removeStep = (stepId: string) => {
    const index = spec.steps.findIndex((entry) => entry.stepId === stepId);
    const next = deleteStep(spec, stepId);
    update(next);
    if (selection.kind === 'step' && selection.stepId === stepId) {
      const fallback = next.steps[Math.max(0, index - 1)];
      setSelection(fallback ? { kind: 'step', stepId: fallback.stepId } : { kind: 'intro' });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <VersionBar
        titleDe={spec.title}
        descriptionDe="Mehrstufiges Formular: Schritte, Verzweigungen, Qualifizierung und Ergebnisseiten."
        spec={spec}
        version={version}
        published={published}
        dirty={dirty}
        blocking={blocking}
        issueSummaryDe={issueSummaryTextDe(issues)}
        versions={versions}
        commands={commands}
        onOpenVersion={onOpenVersion}
        onSaved={() => setDirty(false)}
      />

      <IssueSummaryPanel issues={issues} titleDe="Offene Hinweise zum Formular" />

      <div className="flex gap-2 md:hidden" role="group" aria-label="Bereich wählen">
        {(
          [
            ['structure', 'Struktur'],
            ['editor', 'Bearbeiten'],
            ['preview', 'Vorschau'],
          ] as const
        ).map(([id, labelDe]) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={pane === id ? 'secondary' : 'ghost'}
            aria-pressed={pane === id}
            onClick={() => setPane(id)}
          >
            {labelDe}
          </Button>
        ))}
      </div>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_26rem]">
        {/* Pane 1 — structure */}
        <nav
          aria-label="Struktur des Formulars"
          className={cn(
            'flex min-w-0 flex-col gap-4',
            pane !== 'structure' && 'max-md:hidden',
          )}
        >
          <ul className="flex flex-col gap-1">
            {(
              [
                ['intro', 'Startbildschirm'],
                ['qualification', 'Qualifizierung'],
                ['results', 'Ergebnisseiten'],
                ['consent', 'Einwilligung & Absenden'],
              ] as const
            ).map(([kind, labelDe]) => (
              <li key={kind}>
                <Button
                  type="button"
                  variant={selection.kind === kind ? 'secondary' : 'ghost'}
                  block
                  className="justify-start"
                  aria-current={selection.kind === kind ? 'true' : undefined}
                  onClick={() => {
                    setSelection({ kind } as Selection);
                    setPane('editor');
                  }}
                >
                  {labelDe}
                </Button>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Schritte
            </h2>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || spec.steps.length >= LIMITS.steps}
              title={
                spec.steps.length >= LIMITS.steps
                  ? `Ein Formular fasst höchstens ${LIMITS.steps} Schritte.`
                  : undefined
              }
              onClick={() => {
                const result = addStep(spec, selectedStep?.stepId ?? null);
                update(result.spec);
                setSelection({ kind: 'step', stepId: result.stepId });
                setPane('editor');
              }}
            >
              <Plus aria-hidden="true" />
              Schritt hinzufügen
            </Button>
          </div>

          <OrderableList
            itemNounDe="Schritt"
            disabled={disabled}
            emptyDe="Noch kein Schritt angelegt."
            onReorder={(from, to) => update(moveStep(spec, from, to))}
            entries={spec.steps.map((step, index) => {
              const stepIssues = issuesFor(issues, ...stepTokens(step.stepId, index));
              const active = selection.kind === 'step' && selection.stepId === step.stepId;
              return {
                id: step.stepId,
                labelDe: step.title,
                content: (
                  <div className="flex flex-col gap-1 px-1">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant={active ? 'secondary' : 'ghost'}
                        size="sm"
                        className="min-w-0 flex-1 justify-start"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => {
                          setSelection({ kind: 'step', stepId: step.stepId });
                          setPane('editor');
                        }}
                      >
                        <span className="truncate">{`${index + 1}. ${step.title}`}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled}
                        aria-label={`Schritt „${step.title}“ duplizieren`}
                        onClick={() => {
                          const result = duplicateStep(spec, step.stepId);
                          update(result.spec);
                          setSelection({ kind: 'step', stepId: result.stepId });
                        }}
                      >
                        <Copy aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled || spec.steps.length <= 1}
                        aria-label={`Schritt „${step.title}“ löschen`}
                        title={
                          spec.steps.length <= 1
                            ? 'Ein Formular benötigt mindestens einen Schritt.'
                            : undefined
                        }
                        onClick={() => setPendingStepDelete(step.stepId)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pl-2">
                      {index === 0 ? (
                        <Badge tone="brand" size="sm">
                          Startschritt
                        </Badge>
                      ) : null}
                      <Badge tone="neutral" size="sm">
                        {STEP_KIND_LABELS_DE[step.kind]}
                      </Badge>
                      <Badge tone="outline" size="sm">
                        {`${step.fieldIds.length} Felder`}
                      </Badge>
                      <IssueMarker issues={stepIssues} subjectDe={`Schritt ${step.title}`} />
                    </div>
                  </div>
                ),
              };
            })}
          />
        </nav>

        {/* Pane 2 — editor */}
        <section
          aria-label="Bearbeiten"
          className={cn('flex min-w-0 flex-col gap-6', pane !== 'editor' && 'max-md:hidden')}
        >
          {selection.kind === 'intro' ? (
            <IntroEditor
              spec={spec}
              issues={issues}
              disabled={disabled}
              onSpecChange={update}
            />
          ) : null}

          {selection.kind === 'qualification' ? (
            <QualificationEditor
              spec={spec}
              issues={issues}
              disabled={disabled}
              onSpecChange={update}
            />
          ) : null}

          {selection.kind === 'results' ? (
            <ResultEditor spec={spec} issues={issues} disabled={disabled} onSpecChange={update} />
          ) : null}

          {selection.kind === 'consent' ? (
            <ConsentSubmitEditor
              spec={spec}
              issues={issues}
              disabled={disabled}
              consentTexts={consentTexts}
              onSpecChange={update}
            />
          ) : null}

          {selection.kind === 'step' && selectedStep ? (
            <StepEditor
              spec={spec}
              step={selectedStep}
              issues={issuesFor(
                issues,
                ...stepTokens(
                  selectedStep.stepId,
                  spec.steps.findIndex((entry) => entry.stepId === selectedStep.stepId),
                ),
                ...selectedStep.fieldIds,
                ...spec.routingRules
                  .filter((rule) => rule.fromStepId === selectedStep.stepId)
                  .map((rule) => rule.ruleId),
              )}
              disabled={disabled}
              onSpecChange={update}
            />
          ) : null}

          {selection.kind === 'step' && !selectedStep ? (
            <p className="text-sm text-muted-foreground">
              Dieser Schritt existiert nicht mehr. Wählen Sie links einen anderen Schritt.
            </p>
          ) : null}
        </section>

        {/* Pane 3 — preview */}
        <section
          aria-label="Vorschau"
          className={cn(
            'flex min-w-0 flex-col gap-4 xl:sticky xl:top-20 xl:self-start',
            pane !== 'preview' && 'max-md:hidden',
            'lg:col-span-2 xl:col-span-1',
          )}
        >
          <FormPreview
            spec={spec}
            noteDe={published ? 'Veröffentlichte Version' : `Entwurf v${version}`}
          />
        </section>
      </div>

      <ConfirmDialog
        open={pendingStepDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingStepDelete(null);
        }}
        title="Schritt löschen"
        description="Der Schritt und die Fragen, die nur auf ihm stehen, werden entfernt."
        confirmLabel="Schritt löschen"
        preview={
          <div className="flex flex-col gap-2 text-sm">
            <p>
              {`Schritt: ${getStep(spec, pendingStepDelete ?? '')?.title ?? pendingStepDelete}`}
            </p>
            <p className="text-muted-foreground">
              {impact && impact.removedFieldIds.length > 0
                ? `Entfernte Fragen: ${impact.removedFieldIds.join(', ')}.`
                : 'Keine Frage wird mit entfernt.'}
            </p>
            <p className="text-muted-foreground">
              {impact && impact.removedRuleIds.length > 0
                ? `Entfernte Verzweigungsregeln: ${impact.removedRuleIds.join(', ')}.`
                : 'Von diesem Schritt gehen keine Verzweigungsregeln aus.'}
            </p>
            {impact && impact.danglingFromStepIds.length > 0 ? (
              <p className="text-warning">
                {`Diese Schritte zeigen anschließend ins Leere und werden als Fehler markiert: ${impact.danglingFromStepIds.join(', ')}.`}
              </p>
            ) : null}
          </div>
        }
        onConfirm={() => {
          if (pendingStepDelete) removeStep(pendingStepDelete);
          setPendingStepDelete(null);
        }}
      />
    </div>
  );
}
