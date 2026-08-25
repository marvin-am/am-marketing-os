'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  allOf,
  QUALIFICATION_OUTCOMES,
  QUALIFICATION_OUTCOME_LABELS_DE,
  type AnalysisSection,
  type MultiStepFormSpec,
  type QualificationOutcome,
  type ResultVariant,
  type ValidationIssue,
} from '@am/funnel-schema';
import { Badge, Button, ConfirmDialog, Section } from '@am/ui';
import {
  CheckboxGroupControl,
  NativeSelect,
  StringListControl,
  SwitchControl,
  TextareaControl,
  TextControl,
} from '../controls';
import { issuesFor, resultVariantTokens } from '../issues';
import { InlineIssues, IssueMarker } from '../issue-views';
import { RESULT_KIND_HINTS_DE, RESULT_KIND_LABELS_DE } from '../labels';
import { OrderableList } from '../orderable';
import { BookingEditor, OptionalCtaEditor, OptionalBookingEditor, RedirectEditor } from '../link-editors';
import { ConditionBuilder } from './condition-builder';
import {
  addResultVariant,
  changeResultVariantKind,
  defaultAtom,
  deleteResultVariant,
  moveResultVariant,
  updateResultVariant,
  LIMITS,
} from './form-ops';
import { deriveUniqueKey } from '../keys';

/**
 * Result states — the screen a visitor actually lands on.
 *
 * `selectResultVariant` takes the **first** variant whose outcome filter and
 * condition match, so the order of this list is the priority order. That is why
 * the variants are reorderable and why the list says so out loud instead of
 * leaving an operator to discover it from a surprising preview.
 */

const RESULT_KINDS: ResultVariant['kind'][] = [
  'THANK_YOU',
  'ANALYSIS',
  'QUALIFIED',
  'NOT_A_FIT',
  'BOOKING',
  'LEAD_MAGNET',
  'REDIRECT',
];

export interface ResultEditorProps {
  spec: MultiStepFormSpec;
  issues: readonly ValidationIssue[];
  disabled: boolean;
  onSpecChange: (spec: MultiStepFormSpec) => void;
}

export function ResultEditor({ spec, issues, disabled, onSpecChange }: ResultEditorProps) {
  const [newKind, setNewKind] = React.useState<ResultVariant['kind']>('THANK_YOU');
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  const newKindId = React.useId();

  return (
    <Section
      heading="Ergebnisseiten"
      headingLevel={3}
      description="Die erste Variante, deren Ergebnis-Filter und Bedingung zutreffen, wird angezeigt. Die Reihenfolge ist deshalb die Priorität."
      actions={
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label
              htmlFor={newKindId}
              className="text-xs font-normal leading-none text-muted-foreground"
            >
              Art der Ergebnisseite
            </label>
            <NativeSelect
              id={newKindId}
              selectSize="sm"
              value={newKind}
              disabled={disabled}
              onChange={(event) => setNewKind(event.target.value as ResultVariant['kind'])}
            >
              {RESULT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {RESULT_KIND_LABELS_DE[kind]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || spec.resultVariants.length >= LIMITS.resultVariants}
            onClick={() => onSpecChange(addResultVariant(spec, newKind).spec)}
          >
            <Plus aria-hidden="true" />
            Ergebnisseite hinzufügen
          </Button>
        </div>
      }
    >
      <OrderableList
        itemNounDe="Ergebnisseite"
        disabled={disabled}
        emptyDe="Noch keine Ergebnisseite. Ohne Ergebnisseite kann die Strecke nicht veröffentlicht werden."
        onReorder={(from, to) => onSpecChange(moveResultVariant(spec, from, to))}
        entries={spec.resultVariants.map((variant, index) => {
          const variantIssues = issuesFor(
            issues,
            ...resultVariantTokens(variant.variantId, index),
          );
          return {
            id: variant.variantId,
            labelDe: variant.headline,
            content: (
              <div className="flex flex-col gap-4 px-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="brand" size="sm">{`Priorität ${index + 1}`}</Badge>
                  <Badge tone="neutral" size="sm">
                    {RESULT_KIND_LABELS_DE[variant.kind]}
                  </Badge>
                  <IssueMarker
                    issues={variantIssues}
                    subjectDe={`Ergebnisseite ${variant.headline}`}
                  />
                  <span className="flex-1" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    aria-label={`Ergebnisseite „${variant.headline}“ entfernen`}
                    onClick={() => setPendingDelete(variant.variantId)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>

                <VariantEditor
                  spec={spec}
                  variant={variant}
                  disabled={disabled}
                  issues={variantIssues}
                  onSpecChange={onSpecChange}
                />
              </div>
            ),
          };
        })}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Ergebnisseite entfernen"
        description="Übergänge, die auf diese Ergebnisseite zeigen, bleiben bestehen und werden anschließend als Fehler angezeigt."
        confirmLabel="Ergebnisseite entfernen"
        preview={
          <p className="text-sm">
            {`Kennung: ${pendingDelete}. Prüfen Sie anschließend die Verzweigungen, die auf diese Seite zeigen.`}
          </p>
        }
        onConfirm={() => {
          if (pendingDelete) onSpecChange(deleteResultVariant(spec, pendingDelete));
          setPendingDelete(null);
        }}
      />
    </Section>
  );
}

interface VariantEditorProps {
  spec: MultiStepFormSpec;
  variant: ResultVariant;
  issues: readonly ValidationIssue[];
  disabled: boolean;
  onSpecChange: (spec: MultiStepFormSpec) => void;
}

function VariantEditor({ spec, variant, issues, disabled, onSpecChange }: VariantEditorProps) {
  const patch = (updater: (current: ResultVariant) => ResultVariant) =>
    onSpecChange(updateResultVariant(spec, variant.variantId, updater));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium leading-none text-foreground" htmlFor={`kind-${variant.variantId}`}>
            Art der Ergebnisseite
          </label>
          <NativeSelect
            id={`kind-${variant.variantId}`}
            value={variant.kind}
            disabled={disabled}
            onChange={(event) =>
              onSpecChange(
                changeResultVariantKind(
                  spec,
                  variant.variantId,
                  event.target.value as ResultVariant['kind'],
                ),
              )
            }
          >
            {RESULT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {RESULT_KIND_LABELS_DE[kind]}
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">{RESULT_KIND_HINTS_DE[variant.kind]}</p>
        </div>

        <CheckboxGroupControl<QualificationOutcome>
          label="Nur bei diesen Qualifizierungs-Ergebnissen"
          hint="Keine Auswahl bedeutet: gilt für jedes Ergebnis."
          values={variant.forOutcomes}
          disabled={disabled}
          options={QUALIFICATION_OUTCOMES.map((outcome) => ({
            value: outcome,
            labelDe: QUALIFICATION_OUTCOME_LABELS_DE[outcome],
          }))}
          onChange={(forOutcomes) => patch((current) => ({ ...current, forOutcomes }))}
        />
      </div>

      <TextControl
        label="Überschrift"
        value={variant.headline}
        maxLength={200}
        disabled={disabled}
        onChange={(headline) => patch((current) => ({ ...current, headline }))}
      />
      <TextareaControl
        label="Fließtext"
        value={variant.body}
        maxLength={2000}
        rows={4}
        disabled={disabled}
        onChange={(body) => patch((current) => ({ ...current, body }))}
      />

      <div className="flex flex-col gap-2">
        <SwitchControl
          label="Nur unter einer zusätzlichen Bedingung anzeigen"
          checked={variant.showWhen !== null}
          disabled={disabled}
          onChange={(enabled) =>
            patch((current) => ({
              ...current,
              showWhen: enabled ? allOf(defaultAtom(spec, null)) : null,
            }))
          }
        />
        {variant.showWhen ? (
          <ConditionBuilder
            spec={spec}
            group={variant.showWhen}
            fromStepId={null}
            disabled={disabled}
            onChange={(showWhen) => patch((current) => ({ ...current, showWhen }))}
          />
        ) : null}
      </div>

      <VariantSpecifics
        spec={spec}
        variant={variant}
        disabled={disabled}
        onSpecChange={onSpecChange}
      />

      <InlineIssues issues={issues} />
    </div>
  );
}

function VariantSpecifics({ spec, variant, disabled, onSpecChange }: Omit<VariantEditorProps, 'issues'>) {
  const patch = (updater: (current: ResultVariant) => ResultVariant) =>
    onSpecChange(updateResultVariant(spec, variant.variantId, updater));

  switch (variant.kind) {
    case 'THANK_YOU':
    case 'QUALIFIED':
    case 'BOOKING':
      return (
        <div className="flex flex-col gap-4">
          <StringListControl
            label="Stichpunkte"
            itemNounDe="Stichpunkt"
            values={variant.bullets}
            disabled={disabled}
            maxItems={6}
            onChange={(bullets) =>
              patch((current) =>
                'bullets' in current ? { ...current, bullets } : current,
              )
            }
          />
          {variant.kind === 'BOOKING' ? (
            <BookingEditor
              booking={variant.booking}
              disabled={disabled}
              onChange={(booking) =>
                patch((current) => (current.kind === 'BOOKING' ? { ...current, booking } : current))
              }
            />
          ) : null}
          {variant.kind === 'QUALIFIED' ? (
            <OptionalBookingEditor
              labelDe="Terminbuchung auf dieser Ergebnisseite"
              booking={variant.booking}
              disabled={disabled}
              onChange={(booking) =>
                patch((current) =>
                  current.kind === 'QUALIFIED' ? { ...current, booking } : current,
                )
              }
            />
          ) : null}
          {variant.kind !== 'BOOKING' ? (
            <OptionalCtaEditor
              labelDe="Schaltfläche"
              cta={variant.cta}
              disabled={disabled}
              onChange={(cta) =>
                patch((current) => ('cta' in current ? { ...current, cta } : current))
              }
            />
          ) : null}
        </div>
      );

    case 'NOT_A_FIT':
      return (
        <div className="flex flex-col gap-4">
          <TextareaControl
            label="Ehrliche Alternative"
            hint="Was die Person stattdessen tun kann. Kein Terminangebot, wenn es nicht passt."
            value={variant.alternativeNote}
            maxLength={600}
            rows={3}
            disabled={disabled}
            onChange={(alternativeNote) =>
              patch((current) =>
                current.kind === 'NOT_A_FIT' ? { ...current, alternativeNote } : current,
              )
            }
          />
          <OptionalCtaEditor
            labelDe="Schaltfläche"
            cta={variant.cta}
            disabled={disabled}
            onChange={(cta) =>
              patch((current) => (current.kind === 'NOT_A_FIT' ? { ...current, cta } : current))
            }
          />
        </div>
      );

    case 'LEAD_MAGNET':
      return (
        <div className="flex flex-col gap-4">
          <TextControl
            label="Bezeichnung der Unterlagen"
            value={variant.assetLabel}
            maxLength={120}
            disabled={disabled}
            onChange={(assetLabel) =>
              patch((current) =>
                current.kind === 'LEAD_MAGNET' ? { ...current, assetLabel } : current,
              )
            }
          />
          <TextControl
            label="Download-Pfad"
            hint="Anwendungsinterner Pfad. Solange nichts hinterlegt ist, verspricht die Seite keinen Download."
            value={variant.assetPath ?? ''}
            maxLength={500}
            disabled={disabled}
            onChange={(assetPath) =>
              patch((current) =>
                current.kind === 'LEAD_MAGNET'
                  ? { ...current, assetPath: assetPath.trim().length === 0 ? null : assetPath }
                  : current,
              )
            }
          />
          <TextareaControl
            label="Hinweis zur Zustellung"
            value={variant.deliveryNote}
            maxLength={400}
            rows={2}
            disabled={disabled}
            onChange={(deliveryNote) =>
              patch((current) =>
                current.kind === 'LEAD_MAGNET' ? { ...current, deliveryNote } : current,
              )
            }
          />
        </div>
      );

    case 'ANALYSIS':
      return (
        <AnalysisSectionsEditor
          spec={spec}
          variant={variant}
          disabled={disabled}
          onSpecChange={onSpecChange}
        />
      );

    case 'REDIRECT':
      return (
        <RedirectEditor
          target={variant.target}
          delaySeconds={variant.delaySeconds}
          disabled={disabled}
          onChange={({ target, delaySeconds }) =>
            patch((current) =>
              current.kind === 'REDIRECT' ? { ...current, target, delaySeconds } : current,
            )
          }
        />
      );

    default:
      return null;
  }
}

interface AnalysisSectionsEditorProps {
  spec: MultiStepFormSpec;
  variant: Extract<ResultVariant, { kind: 'ANALYSIS' }>;
  disabled: boolean;
  onSpecChange: (spec: MultiStepFormSpec) => void;
}

function AnalysisSectionsEditor({
  spec,
  variant,
  disabled,
  onSpecChange,
}: AnalysisSectionsEditorProps) {
  const setSections = (sections: AnalysisSection[]) =>
    onSpecChange(
      updateResultVariant(spec, variant.variantId, (current) =>
        current.kind === 'ANALYSIS' ? { ...current, sections } : current,
      ),
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Abschnitte der Auswertung</h4>
          <p className="text-xs text-muted-foreground">
            Jeder Abschnitt kann an eine Bedingung geknüpft werden und erscheint nur, wenn sie
            zutrifft.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || variant.sections.length >= 10}
          onClick={() =>
            setSections([
              ...variant.sections,
              {
                key: deriveUniqueKey(
                  'Neuer Abschnitt',
                  variant.sections.map((section) => section.key),
                  'abschnitt',
                ),
                title: 'Neuer Abschnitt',
                body: 'Beschreiben Sie, was dieser Abschnitt der Auswertung aussagt.',
                showWhen: null,
              },
            ])
          }
        >
          <Plus aria-hidden="true" />
          Abschnitt hinzufügen
        </Button>
      </div>

      <OrderableList
        itemNounDe="Abschnitt"
        disabled={disabled}
        onReorder={(from, to) => {
          const next = [...variant.sections];
          const [moved] = next.splice(from, 1);
          if (moved) next.splice(to, 0, moved);
          setSections(next);
        }}
        entries={variant.sections.map((section, index) => ({
          id: section.key,
          labelDe: section.title,
          content: (
            <div className="flex flex-col gap-3 px-1">
              <div className="flex items-center gap-2">
                <TextControl
                  className="flex-1"
                  label="Überschrift des Abschnitts"
                  value={section.title}
                  maxLength={160}
                  disabled={disabled}
                  onChange={(title) =>
                    setSections(
                      variant.sections.map((entry, position) =>
                        position === index ? { ...entry, title } : entry,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || variant.sections.length <= 1}
                  aria-label={`Abschnitt „${section.title}“ entfernen`}
                  title={
                    variant.sections.length <= 1
                      ? 'Eine Auswertung benötigt mindestens einen Abschnitt.'
                      : undefined
                  }
                  onClick={() =>
                    setSections(variant.sections.filter((_, position) => position !== index))
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              <TextareaControl
                label="Text des Abschnitts"
                value={section.body}
                maxLength={2000}
                rows={3}
                disabled={disabled}
                onChange={(body) =>
                  setSections(
                    variant.sections.map((entry, position) =>
                      position === index ? { ...entry, body } : entry,
                    ),
                  )
                }
              />
              <SwitchControl
                label="Nur unter Bedingung anzeigen"
                checked={section.showWhen !== null}
                disabled={disabled}
                onChange={(enabled) =>
                  setSections(
                    variant.sections.map((entry, position) =>
                      position === index
                        ? {
                            ...entry,
                            showWhen: enabled ? allOf(defaultAtom(spec, null)) : null,
                          }
                        : entry,
                    ),
                  )
                }
              />
              {section.showWhen ? (
                <ConditionBuilder
                  spec={spec}
                  group={section.showWhen}
                  fromStepId={null}
                  disabled={disabled}
                  onChange={(showWhen) =>
                    setSections(
                      variant.sections.map((entry, position) =>
                        position === index ? { ...entry, showWhen } : entry,
                      ),
                    )
                  }
                />
              ) : null}
            </div>
          ),
        }))}
      />

      <TextareaControl
        label="Methodenhinweis"
        hint="Steht neben jeder berechneten Aussage und macht klar, worauf sie beruht."
        value={variant.methodNote}
        maxLength={400}
        rows={2}
        disabled={disabled}
        onChange={(methodNote) =>
          onSpecChange(
            updateResultVariant(spec, variant.variantId, (current) =>
              current.kind === 'ANALYSIS' ? { ...current, methodNote } : current,
            ),
          )
        }
      />

      <OptionalCtaEditor
        labelDe="Schaltfläche unter der Auswertung"
        cta={variant.cta}
        disabled={disabled}
        onChange={(cta) =>
          onSpecChange(
            updateResultVariant(spec, variant.variantId, (current) =>
              current.kind === 'ANALYSIS' ? { ...current, cta } : current,
            ),
          )
        }
      />
    </div>
  );
}
