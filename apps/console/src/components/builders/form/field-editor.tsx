'use client';

import * as React from 'react';
import { Lock, Plus, Trash2 } from 'lucide-react';
import {
  FIELD_TYPES,
  PII_CLASSES,
  QUALIFICATION_CLASSES,
  type FieldType,
} from '@am/domain';
import {
  isSelectField,
  NORMALIZATION_RULES,
  type FormField,
  type MultiStepFormSpec,
  type NormalizationRule,
  type ValidationIssue,
} from '@am/funnel-schema';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  ConfirmDialog,
  Tooltip,
} from '@am/ui';
import {
  NumberControl,
  OptionalTextControl,
  SelectControl,
  SwitchControl,
  TextControl,
} from '../controls';
import { InlineIssues } from '../issue-views';
import {
  FIELD_TYPE_HINTS_DE,
  FIELD_TYPE_LABELS_DE,
  NORMALIZATION_LABELS_DE,
  OPTION_ID_FROZEN_NOTE_DE,
  PII_CLASS_LABELS_DE,
  QUALIFICATION_CLASS_LABELS_DE,
  SELECT_DISPLAY_LABELS_DE,
} from '../labels';
import { OrderableList } from '../orderable';
import {
  addOption,
  changeFieldType,
  deleteOption,
  moveOption,
  rulesReferencingOption,
  updateField,
  updateOption,
  LIMITS,
} from './form-ops';

/**
 * The editor for one field, including its answer options.
 *
 * The one thing worth reading twice is the option id. It is derived from the
 * German label at creation and then rendered as text, never as an input:
 * routing rules, qualification rules, analytics and the CRM all store that id,
 * so changing it after a version has been published would give every historical
 * answer a new meaning without anybody noticing. The label above it stays fully
 * editable, because nothing but a human reads the label.
 */

export interface FieldEditorProps {
  spec: MultiStepFormSpec;
  field: FormField;
  issues: readonly ValidationIssue[];
  disabled: boolean;
  onSpecChange: (spec: MultiStepFormSpec) => void;
}

export function FieldEditor({
  spec,
  field,
  issues,
  disabled,
  onSpecChange,
}: FieldEditorProps) {
  const fieldId = field.fieldId;
  const isConsent = field.type === 'CONSENT';

  const patch = (updater: (current: FormField) => FormField) =>
    onSpecChange(updateField(spec, fieldId, updater));

  return (
    <div className="flex flex-col gap-4">
      <TextControl
        label="Beschriftung"
        value={field.label}
        disabled={disabled}
        maxLength={200}
        onChange={(label) => patch((current) => ({ ...current, label }))}
        labelAside={<FrozenKeyBadge keyValue={fieldId} subjectDe="Feld-Kennung" />}
      />

      <OptionalTextControl
        label="Hilfetext"
        hint="Erklärender Satz unter der Frage. Leer lassen, wenn die Frage für sich spricht."
        value={field.helpText}
        disabled={disabled}
        maxLength={400}
        onChange={(helpText) => patch((current) => ({ ...current, helpText }))}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectControl<FieldType>
          label="Feldtyp"
          value={field.type}
          disabled={disabled || isConsent}
          hint={
            isConsent
              ? 'Das Einwilligungsfeld ist an die Einwilligungserklärung gebunden und behält seinen Typ.'
              : FIELD_TYPE_HINTS_DE[field.type]
          }
          options={FIELD_TYPES.map((type) => ({
            value: type,
            labelDe: FIELD_TYPE_LABELS_DE[type],
            disabled: type === 'CONSENT',
          }))}
          onChange={(type) => onSpecChange(changeFieldType(spec, fieldId, type))}
        />

        <SwitchControl
          label="Pflichtfeld"
          checked={field.required}
          disabled={disabled || isConsent}
          hint={
            isConsent
              ? 'Eine Einwilligung ist immer verpflichtend.'
              : 'Ohne Antwort geht es nicht weiter.'
          }
          onChange={(required) => patch((current) => ({ ...current, required }))}
        />
      </div>

      {field.type !== 'SINGLE_SELECT' &&
      field.type !== 'MULTI_SELECT' &&
      field.type !== 'BOOLEAN' &&
      field.type !== 'CONSENT' ? (
        <OptionalTextControl
          label="Platzhaltertext"
          value={field.placeholder}
          disabled={disabled}
          maxLength={120}
          hint="Beispieltext im leeren Eingabefeld. Ersetzt niemals die Beschriftung."
          onChange={(placeholder) => patch((current) => ({ ...current, placeholder }))}
        />
      ) : null}

      <TypeSpecificSettings
        spec={spec}
        field={field}
        disabled={disabled}
        onSpecChange={onSpecChange}
      />

      {isSelectField(field) ? (
        <OptionsEditor
          spec={spec}
          field={field}
          disabled={disabled}
          onSpecChange={onSpecChange}
        />
      ) : null}

      <Accordion type="single" collapsible>
        <AccordionItem value="advanced">
          <AccordionTrigger>Erweiterte Einstellungen</AccordionTrigger>
          <AccordionContent>
            <div className="grid gap-4 pt-2 sm:grid-cols-2">
              <NumberControl
                label="Maximale Zeichenzahl"
                value={field.maxLength}
                min={1}
                max={8000}
                disabled={disabled || field.type === 'POSTCODE'}
                hint={
                  field.type === 'POSTCODE'
                    ? 'Eine deutsche Postleitzahl hat immer genau fünf Stellen.'
                    : 'Begrenzt die Länge der Antwort.'
                }
                onChange={(maxLength) => patch((current) => ({ ...current, maxLength }))}
              />
              <SelectControl
                label="Datenklassifizierung"
                value={field.piiClass}
                disabled={disabled}
                hint="Entscheidet, wo die Antwort gespeichert wird und ob sie in Auswertungen erscheinen darf."
                options={PII_CLASSES.map((value) => ({
                  value,
                  labelDe: PII_CLASS_LABELS_DE[value],
                }))}
                onChange={(piiClass) => patch((current) => ({ ...current, piiClass }))}
              />
              <SelectControl
                label="Bedeutung für die Qualifizierung"
                value={field.qualificationClass}
                disabled={disabled}
                options={QUALIFICATION_CLASSES.map((value) => ({
                  value,
                  labelDe: QUALIFICATION_CLASS_LABELS_DE[value],
                }))}
                onChange={(qualificationClass) =>
                  patch((current) => ({ ...current, qualificationClass }))
                }
              />
              <SelectControl
                label="Normalisierung der Antwort"
                value={field.normalization}
                disabled={disabled}
                options={NORMALIZATION_RULES.map((value: NormalizationRule) => ({
                  value,
                  labelDe: NORMALIZATION_LABELS_DE[value],
                }))}
                onChange={(normalization) =>
                  patch((current) => ({ ...current, normalization }))
                }
              />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <InlineIssues issues={issues} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Frozen key badge                                                            */
/* -------------------------------------------------------------------------- */

function FrozenKeyBadge({ keyValue, subjectDe }: { keyValue: string; subjectDe: string }) {
  return (
    <Tooltip content={OPTION_ID_FROZEN_NOTE_DE}>
      <Badge tone="neutral" size="sm" className="font-mono">
        <Lock aria-hidden="true" />
        <span className="sr-only">{`${subjectDe}, unveränderlich: `}</span>
        {keyValue}
      </Badge>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* Type-specific settings                                                      */
/* -------------------------------------------------------------------------- */

interface TypeSettingsProps {
  spec: MultiStepFormSpec;
  field: FormField;
  disabled: boolean;
  onSpecChange: (spec: MultiStepFormSpec) => void;
}

function TypeSpecificSettings({ spec, field, disabled, onSpecChange }: TypeSettingsProps) {
  const patch = (updater: (current: FormField) => FormField) =>
    onSpecChange(updateField(spec, field.fieldId, updater));

  switch (field.type) {
    case 'SINGLE_SELECT':
      return (
        <SelectControl
          label="Darstellung"
          value={field.display}
          disabled={disabled}
          options={(['CARDS', 'RADIO', 'DROPDOWN'] as const).map((value) => ({
            value,
            labelDe: SELECT_DISPLAY_LABELS_DE[value],
          }))}
          onChange={(display) =>
            patch((current) =>
              current.type === 'SINGLE_SELECT' ? { ...current, display } : current,
            )
          }
        />
      );
    case 'MULTI_SELECT':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberControl
            label="Mindestens auszuwählen"
            value={field.minSelected}
            min={0}
            max={LIMITS.optionsPerField}
            disabled={disabled}
            onChange={(minSelected) =>
              patch((current) =>
                current.type === 'MULTI_SELECT' ? { ...current, minSelected } : current,
              )
            }
          />
          <NumberControl
            label="Höchstens auszuwählen"
            value={field.maxSelected}
            min={1}
            max={LIMITS.optionsPerField}
            disabled={disabled}
            onChange={(maxSelected) =>
              patch((current) =>
                current.type === 'MULTI_SELECT' ? { ...current, maxSelected } : current,
              )
            }
          />
        </div>
      );
    case 'BOOLEAN':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextControl
            label="Beschriftung für „Ja“"
            value={field.trueLabel}
            maxLength={60}
            disabled={disabled}
            onChange={(trueLabel) =>
              patch((current) => (current.type === 'BOOLEAN' ? { ...current, trueLabel } : current))
            }
          />
          <TextControl
            label="Beschriftung für „Nein“"
            value={field.falseLabel}
            maxLength={60}
            disabled={disabled}
            onChange={(falseLabel) =>
              patch((current) => (current.type === 'BOOLEAN' ? { ...current, falseLabel } : current))
            }
          />
        </div>
      );
    case 'NUMBER':
    case 'RANGE':
      return (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberControl
              label="Kleinster erlaubter Wert"
              value={field.min}
              disabled={disabled}
              onChange={(min) =>
                patch((current) =>
                  current.type === 'NUMBER' || current.type === 'RANGE'
                    ? { ...current, min }
                    : current,
                )
              }
            />
            <NumberControl
              label="Größter erlaubter Wert"
              value={field.max}
              disabled={disabled}
              onChange={(max) =>
                patch((current) =>
                  current.type === 'NUMBER' || current.type === 'RANGE'
                    ? { ...current, max }
                    : current,
                )
              }
            />
            <NumberControl
              label="Schrittweite"
              value={field.step}
              min={0.01}
              disabled={disabled}
              onChange={(step) =>
                patch((current) =>
                  current.type === 'NUMBER' || current.type === 'RANGE'
                    ? { ...current, step: step > 0 ? step : 1 }
                    : current,
                )
              }
            />
          </div>
          <OptionalTextControl
            label="Einheit"
            value={field.unit}
            maxLength={20}
            disabled={disabled}
            hint="Zum Beispiel „€“ oder „Mitarbeitende“."
            onChange={(unit) =>
              patch((current) =>
                current.type === 'NUMBER' || current.type === 'RANGE'
                  ? { ...current, unit }
                  : current,
              )
            }
          />
          {field.type === 'RANGE' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <OptionalTextControl
                label="Beschriftung am linken Ende"
                value={field.minLabel}
                maxLength={60}
                disabled={disabled}
                onChange={(minLabel) =>
                  patch((current) => (current.type === 'RANGE' ? { ...current, minLabel } : current))
                }
              />
              <OptionalTextControl
                label="Beschriftung am rechten Ende"
                value={field.maxLabel}
                maxLength={60}
                disabled={disabled}
                onChange={(maxLabel) =>
                  patch((current) => (current.type === 'RANGE' ? { ...current, maxLabel } : current))
                }
              />
            </div>
          ) : null}
        </div>
      );
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
    case 'FIRST_NAME':
    case 'LAST_NAME':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberControl
            label="Mindestlänge"
            value={field.minLength}
            min={0}
            max={8000}
            disabled={disabled}
            onChange={(minLength) =>
              patch((current) =>
                'minLength' in current ? { ...current, minLength } : current,
              )
            }
          />
          {field.type === 'LONG_TEXT' ? (
            <NumberControl
              label="Sichtbare Zeilen"
              value={field.rows}
              min={2}
              max={12}
              disabled={disabled}
              onChange={(rows) =>
                patch((current) => (current.type === 'LONG_TEXT' ? { ...current, rows } : current))
              }
            />
          ) : null}
        </div>
      );
    case 'CONSENT':
      return (
        <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          Der Einwilligungstext und die Consent-Version werden im Bereich „Einwilligung &amp;
          Absenden“ gepflegt. Das Kästchen startet immer leer.
        </p>
      );
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

interface OptionsEditorProps {
  spec: MultiStepFormSpec;
  field: Extract<FormField, { type: 'SINGLE_SELECT' | 'MULTI_SELECT' }>;
  disabled: boolean;
  onSpecChange: (spec: MultiStepFormSpec) => void;
}

function OptionsEditor({ spec, field, disabled, onSpecChange }: OptionsEditorProps) {
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  const referencing = pendingDelete ? rulesReferencingOption(spec, pendingDelete) : [];
  const atMinimum = field.options.length <= LIMITS.minOptionsPerField;

  return (
    <section className="flex flex-col gap-3" aria-label="Antwortoptionen">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Antwortoptionen</h4>
          <p className="text-xs text-muted-foreground">{OPTION_ID_FROZEN_NOTE_DE}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || field.options.length >= LIMITS.optionsPerField}
          onClick={() => onSpecChange(addOption(spec, field.fieldId).spec)}
        >
          <Plus aria-hidden="true" />
          Antwort hinzufügen
        </Button>
      </div>

      <OrderableList
        itemNounDe="Antwort"
        disabled={disabled}
        onReorder={(from, to) => onSpecChange(moveOption(spec, field.fieldId, from, to))}
        entries={field.options.map((option) => ({
          id: option.optionId,
          labelDe: option.label,
          content: (
            <div className="flex flex-col gap-2 px-1">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <TextControl
                  className="flex-1"
                  label="Sichtbare Beschriftung"
                  value={option.label}
                  maxLength={200}
                  disabled={disabled}
                  onChange={(label) =>
                    onSpecChange(updateOption(spec, field.fieldId, option.optionId, { label }))
                  }
                  labelAside={
                    <FrozenKeyBadge keyValue={option.optionId} subjectDe="Antwort-Kennung" />
                  }
                />
                <NumberControl
                  className="sm:w-32"
                  label="Punkte"
                  value={option.score}
                  min={-100}
                  max={100}
                  disabled={disabled}
                  onChange={(score) =>
                    onSpecChange(updateOption(spec, field.fieldId, option.optionId, { score }))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || atMinimum}
                  aria-label={`Antwort „${option.label}“ entfernen`}
                  title={
                    atMinimum
                      ? 'Eine Auswahlfrage benötigt mindestens zwei Antwortoptionen.'
                      : undefined
                  }
                  onClick={() => setPendingDelete(option.optionId)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              <OptionalTextControl
                label="Hilfetext zur Antwort"
                value={option.helpText}
                maxLength={300}
                disabled={disabled}
                onChange={(helpText) =>
                  onSpecChange(updateOption(spec, field.fieldId, option.optionId, { helpText }))
                }
              />
            </div>
          ),
        }))}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Antwortoption entfernen"
        description="Die Option verschwindet aus dem Formular. Bereits erfasste Antworten behalten ihre Kennung."
        confirmLabel="Option entfernen"
        preview={
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Kennung: <span className="font-mono">{pendingDelete}</span>
            </p>
            {referencing.length > 0 ? (
              <p className="text-warning">
                {`Diese Option wird in ${referencing.length} Regel(n) verwendet: ${referencing.join(', ')}. `}
                Die Regeln bleiben bestehen und werden anschließend als Fehler angezeigt.
              </p>
            ) : (
              <p className="text-muted-foreground">Keine Regel verweist auf diese Option.</p>
            )}
          </div>
        }
        onConfirm={() => {
          if (pendingDelete) onSpecChange(deleteOption(spec, field.fieldId, pendingDelete));
          setPendingDelete(null);
        }}
      />
    </section>
  );
}
