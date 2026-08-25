'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { FIELD_TYPES, type FieldType } from '@am/domain';
import {
  getField,
  routingRulesFor,
  STEP_KINDS,
  type FormStep,
  type MultiStepFormSpec,
  type ValidationIssue,
} from '@am/funnel-schema';
import { cn, Badge, Button, ConfirmDialog, Label, Section } from '@am/ui';
import {
  NativeSelect,
  OptionalTextControl,
  SelectControl,
  SwitchControl,
  TextControl,
} from '../controls';
import { fieldTokens, issuesFor, routingRuleTokens } from '../issues';
import { InlineIssues, IssueMarker } from '../issue-views';
import { FIELD_TYPE_LABELS_DE, STEP_KIND_LABELS_DE } from '../labels';
import { OrderableList } from '../orderable';
import { ConditionBuilder } from './condition-builder';
import { FieldEditor } from './field-editor';
import { TargetPicker } from './target-picker';
import {
  addFieldToStep,
  addRoutingRule,
  deleteField,
  deleteRoutingRule,
  moveFieldInStep,
  moveRoutingRule,
  rulesReferencingField,
  updateRoutingRule,
  updateStep,
  LIMITS,
} from './form-ops';

/**
 * The centre pane for one step: what it asks, how it looks and where it leads.
 *
 * Routing lives here rather than in a separate "logic" screen because a branch
 * is a property of the step it starts from. Rules are shown in evaluation order
 * and can be reordered, since "the first matching rule wins" makes their order a
 * real setting rather than a display detail.
 */

export interface StepEditorProps {
  spec: MultiStepFormSpec;
  step: FormStep;
  issues: readonly ValidationIssue[];
  disabled: boolean;
  onSpecChange: (spec: MultiStepFormSpec) => void;
}

export function StepEditor({ spec, step, issues, disabled, onSpecChange }: StepEditorProps) {
  const [newFieldType, setNewFieldType] = React.useState<FieldType>('SINGLE_SELECT');
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const [pendingFieldDelete, setPendingFieldDelete] = React.useState<string | null>(null);
  const newFieldTypeId = React.useId();

  const stepIndex = spec.steps.findIndex((entry) => entry.stepId === step.stepId);
  const rules = routingRulesFor(spec, step.stepId);
  const ownIssues = issues.filter(
    (issue) => !rules.some((rule) => issue.pathDe.includes(rule.ruleId)),
  );

  const patchStep = (updater: (current: FormStep) => FormStep) =>
    onSpecChange(updateStep(spec, step.stepId, updater));

  const toggleField = (fieldId: string) =>
    setExpanded((current) =>
      current.includes(fieldId)
        ? current.filter((entry) => entry !== fieldId)
        : [...current, fieldId],
    );

  const referencingRules = pendingFieldDelete
    ? rulesReferencingField(spec, pendingFieldDelete)
    : [];

  return (
    <div className="flex flex-col gap-8">
      <Section heading="Inhalt des Schritts" headingLevel={3}>
        <div className="flex flex-col gap-4">
          <TextControl
            label="Überschrift"
            value={step.title}
            maxLength={160}
            disabled={disabled}
            issues={issuesFor(ownIssues, 'title', `steps.${stepIndex}.title`)}
            onChange={(title) => patchStep((current) => ({ ...current, title }))}
          />
          <OptionalTextControl
            label="Unterzeile"
            hint="Ein Satz unter der Überschrift. Erklärt, warum die Frage gestellt wird."
            value={step.subtitle}
            maxLength={400}
            disabled={disabled}
            onChange={(subtitle) => patchStep((current) => ({ ...current, subtitle }))}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectControl
              label="Art des Schritts"
              value={step.kind}
              disabled={disabled}
              hint="Steuert, wie der Schritt in Auswertungen eingeordnet wird."
              options={STEP_KINDS.map((kind) => ({
                value: kind,
                labelDe: STEP_KIND_LABELS_DE[kind],
              }))}
              onChange={(kind) => patchStep((current) => ({ ...current, kind }))}
            />
            <SwitchControl
              label="Fortschritt anzeigen"
              checked={step.showProgress}
              disabled={disabled}
              hint="Der Fortschritt wird nur als Prozentwert angezeigt, wenn jeder Pfad gleich lang ist."
              onChange={(showProgress) => patchStep((current) => ({ ...current, showProgress }))}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextControl
              label="Beschriftung der Weiter-Schaltfläche"
              value={step.primaryCtaLabel}
              maxLength={60}
              disabled={disabled}
              onChange={(primaryCtaLabel) =>
                patchStep((current) => ({ ...current, primaryCtaLabel }))
              }
            />
            <OptionalTextControl
              label="Beschriftung der Zurück-Schaltfläche"
              value={step.secondaryCtaLabel}
              maxLength={60}
              disabled={disabled}
              hint="Leer lassen, um keinen Zurück-Weg anzubieten."
              onChange={(secondaryCtaLabel) =>
                patchStep((current) => ({ ...current, secondaryCtaLabel }))
              }
            />
          </div>
        </div>
      </Section>

      <Section
        heading="Fragen auf diesem Schritt"
        headingLevel={3}
        description="Reihenfolge per Ziehen oder mit den Pfeil-Schaltflächen. Beides ändert dieselbe Reihenfolge."
        actions={
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={newFieldTypeId} className="text-xs font-normal text-muted-foreground">
                Feldtyp
              </Label>
              <NativeSelect
                id={newFieldTypeId}
                selectSize="sm"
                value={newFieldType}
                disabled={disabled}
                onChange={(event) => setNewFieldType(event.target.value as FieldType)}
              >
                {FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {FIELD_TYPE_LABELS_DE[type]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || step.fieldIds.length >= LIMITS.fieldsPerStep}
              title={
                step.fieldIds.length >= LIMITS.fieldsPerStep
                  ? `Ein Schritt fasst höchstens ${LIMITS.fieldsPerStep} Felder.`
                  : undefined
              }
              onClick={() => {
                const result = addFieldToStep(spec, step.stepId, newFieldType);
                onSpecChange(result.spec);
                if (result.fieldId) setExpanded((current) => [...current, result.fieldId]);
              }}
            >
              <Plus aria-hidden="true" />
              Feld hinzufügen
            </Button>
          </div>
        }
      >
        <OrderableList
          itemNounDe="Feld"
          disabled={disabled}
          emptyDe="Dieser Schritt zeigt noch keine Frage. Fügen Sie mindestens ein Feld hinzu."
          onReorder={(from, to) => onSpecChange(moveFieldInStep(spec, step.stepId, from, to))}
          entries={step.fieldIds.map((fieldId) => {
            const field = getField(spec, fieldId);
            const fieldIssues = issuesFor(issues, ...fieldTokens(fieldId));
            const isOpen = expanded.includes(fieldId);

            return {
              id: fieldId,
              labelDe: field?.label ?? fieldId,
              content: (
                <div className="flex flex-col gap-3 px-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-expanded={isOpen}
                      className="min-w-0 flex-1 justify-start"
                      onClick={() => toggleField(fieldId)}
                    >
                      {isOpen ? (
                        <ChevronDown aria-hidden="true" />
                      ) : (
                        <ChevronRight aria-hidden="true" />
                      )}
                      <span className="truncate">{field?.label ?? fieldId}</span>
                    </Button>
                    <Badge tone="neutral" size="sm">
                      {field ? FIELD_TYPE_LABELS_DE[field.type] : 'Unbekanntes Feld'}
                    </Badge>
                    {field?.required ? (
                      <Badge tone="outline" size="sm">
                        Pflicht
                      </Badge>
                    ) : null}
                    <IssueMarker issues={fieldIssues} subjectDe={`Feld ${field?.label ?? fieldId}`} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled}
                      aria-label={`Feld „${field?.label ?? fieldId}“ entfernen`}
                      onClick={() => setPendingFieldDelete(fieldId)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>

                  {isOpen && field ? (
                    <div className="rounded-md border border-border bg-surface-sunken p-3">
                      <FieldEditor
                        spec={spec}
                        field={field}
                        issues={fieldIssues}
                        disabled={disabled}
                        onSpecChange={onSpecChange}
                      />
                    </div>
                  ) : null}

                  {!isOpen ? <InlineIssues issues={fieldIssues} /> : null}
                </div>
              ),
            };
          })}
        />
      </Section>

      <Section
        heading="Verzweigungen ab diesem Schritt"
        headingLevel={3}
        description="Die Regeln werden von oben nach unten geprüft. Die erste zutreffende Regel gewinnt; trifft keine zu, gilt der Standardübergang."
        actions={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || spec.routingRules.length >= LIMITS.routingRules}
            onClick={() => onSpecChange(addRoutingRule(spec, step.stepId).spec)}
          >
            <Plus aria-hidden="true" />
            Regel hinzufügen
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <OrderableList
            itemNounDe="Regel"
            disabled={disabled}
            emptyDe="Keine Verzweigung. Alle Besucherinnen und Besucher folgen dem Standardübergang."
            onReorder={(from, to) => onSpecChange(moveRoutingRule(spec, step.stepId, from, to))}
            entries={rules.map((rule, index) => {
              const ruleIssues = issuesFor(issues, ...routingRuleTokens(rule.ruleId, index));
              return {
                id: rule.ruleId,
                labelDe: rule.description,
                content: (
                  <div className="flex flex-col gap-3 px-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="brand" size="sm">{`Regel ${index + 1}`}</Badge>
                      <IssueMarker issues={ruleIssues} subjectDe={`Regel ${rule.ruleId}`} />
                      <span className="flex-1" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled}
                        aria-label={`Regel „${rule.description}“ entfernen`}
                        onClick={() => onSpecChange(deleteRoutingRule(spec, rule.ruleId))}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>

                    <TextControl
                      label="Beschreibung der Regel"
                      hint="Wird nur im Builder angezeigt und erklärt Kolleginnen und Kollegen, wofür die Regel da ist."
                      value={rule.description}
                      maxLength={300}
                      disabled={disabled}
                      onChange={(description) =>
                        onSpecChange(
                          updateRoutingRule(spec, rule.ruleId, (current) => ({
                            ...current,
                            description,
                          })),
                        )
                      }
                    />

                    <ConditionBuilder
                      spec={spec}
                      group={rule.when}
                      fromStepId={step.stepId}
                      disabled={disabled}
                      onChange={(when) =>
                        onSpecChange(
                          updateRoutingRule(spec, rule.ruleId, (current) => ({ ...current, when })),
                        )
                      }
                    />

                    <TargetPicker
                      spec={spec}
                      target={rule.target}
                      labelDe="Dann"
                      excludeStepId={step.stepId}
                      disabled={disabled}
                      onChange={(target) =>
                        onSpecChange(
                          updateRoutingRule(spec, rule.ruleId, (current) => ({
                            ...current,
                            target,
                          })),
                        )
                      }
                    />

                    <InlineIssues issues={ruleIssues} />
                  </div>
                ),
              };
            })}
          />

          <div className="rounded-md border border-border bg-surface p-3">
            <TargetPicker
              spec={spec}
              target={step.defaultNext}
              labelDe="Standardübergang"
              hintDe="Gilt, wenn keine Regel zutrifft."
              excludeStepId={step.stepId}
              disabled={disabled}
              issues={issuesFor(ownIssues, 'Standardübergang')}
              onChange={(defaultNext) => patchStep((current) => ({ ...current, defaultNext }))}
            />
          </div>

          <InlineIssues
            issues={ownIssues.filter((issue) => issue.code === 'STEP_NOT_TERMINATING')}
            className={cn('pt-1')}
          />
        </div>
      </Section>

      <ConfirmDialog
        open={pendingFieldDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingFieldDelete(null);
        }}
        title="Feld entfernen"
        description="Das Feld wird aus dem Formular gelöscht. Bereits erfasste Antworten bleiben in der Datenbank erhalten."
        confirmLabel="Feld entfernen"
        preview={
          <div className="flex flex-col gap-2 text-sm">
            <p>
              {`Feld: ${getField(spec, pendingFieldDelete ?? '')?.label ?? pendingFieldDelete}`}
            </p>
            {referencingRules.length > 0 ? (
              <p className="text-warning">
                {`${referencingRules.length} Regel(n) verweisen auf dieses Feld: ${referencingRules.join(', ')}. `}
                Sie bleiben bestehen und werden anschließend als Fehler angezeigt.
              </p>
            ) : (
              <p className="text-muted-foreground">Keine Regel verweist auf dieses Feld.</p>
            )}
          </div>
        }
        onConfirm={() => {
          if (pendingFieldDelete) onSpecChange(deleteField(spec, pendingFieldDelete));
          setPendingFieldDelete(null);
        }}
      />
    </div>
  );
}
