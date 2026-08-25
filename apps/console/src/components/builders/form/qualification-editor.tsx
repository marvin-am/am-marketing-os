'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  evaluateQualification,
  QUALIFICATION_OUTCOMES,
  QUALIFICATION_OUTCOME_LABELS_DE,
  type MultiStepFormSpec,
  type QualificationRule,
  type ValidationIssue,
} from '@am/funnel-schema';
import { Badge, Button, Section } from '@am/ui';
import { NativeSelect, NumberControl, SelectControl, TextControl } from '../controls';
import { issuesFor, qualificationRuleTokens } from '../issues';
import { InlineIssues, IssueMarker } from '../issue-views';
import {
  QUALIFICATION_EFFECT_HINTS_DE,
  QUALIFICATION_EFFECT_LABELS_DE,
} from '../labels';
import { OrderableList } from '../orderable';
import { ConditionBuilder } from './condition-builder';
import {
  addQualificationRule,
  changeQualificationEffect,
  deleteQualificationRule,
  moveQualificationRule,
  updateQualificationRule,
  LIMITS,
} from './form-ops';

/**
 * Qualification rules: the scoreboard that decides whether an enquiry is a fit.
 *
 * The panel shows the score an empty submission would reach, so an operator can
 * see what the thresholds mean without leaving the screen. That number comes
 * from `evaluateQualification` — the same function the server uses — rather than
 * from a second implementation that could drift.
 */

const EFFECTS: QualificationRule['effect'][] = ['SCORE', 'QUALIFY', 'DISQUALIFY', 'CLASSIFY'];

export interface QualificationEditorProps {
  spec: MultiStepFormSpec;
  issues: readonly ValidationIssue[];
  disabled: boolean;
  onSpecChange: (spec: MultiStepFormSpec) => void;
}

export function QualificationEditor({
  spec,
  issues,
  disabled,
  onSpecChange,
}: QualificationEditorProps) {
  const [newEffect, setNewEffect] = React.useState<QualificationRule['effect']>('SCORE');
  const newEffectId = React.useId();
  const baseline = evaluateQualification(spec, {});

  return (
    <Section
      heading="Qualifizierung"
      headingLevel={3}
      description="Punkte aus den Antwortoptionen, zusätzliche Regeln und die Einordnung der Punktzahl. Disqualifizierende Regeln haben immer Vorrang."
      actions={
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label
              htmlFor={newEffectId}
              className="text-xs font-normal leading-none text-muted-foreground"
            >
              Art der Regel
            </label>
            <NativeSelect
              id={newEffectId}
              selectSize="sm"
              value={newEffect}
              disabled={disabled}
              onChange={(event) =>
                setNewEffect(event.target.value as QualificationRule['effect'])
              }
            >
              {EFFECTS.map((effect) => (
                <option key={effect} value={effect}>
                  {QUALIFICATION_EFFECT_LABELS_DE[effect]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || spec.qualificationRules.length >= LIMITS.qualificationRules}
            onClick={() => onSpecChange(addQualificationRule(spec, newEffect).spec)}
          >
            <Plus aria-hidden="true" />
            Regel hinzufügen
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {`Ohne jede Antwort erreicht eine Einreichung ${baseline.score} Punkte und wird als „${QUALIFICATION_OUTCOME_LABELS_DE[baseline.outcome]}“ eingestuft. Die Punkte einzelner Antworten pflegen Sie direkt an der jeweiligen Antwortoption.`}
        </p>

        <OrderableList
          itemNounDe="Qualifizierungsregel"
          disabled={disabled}
          emptyDe="Noch keine Qualifizierungsregel. Ohne Einordnungsregel landet jede Einreichung in der manuellen Prüfung."
          onReorder={(from, to) => onSpecChange(moveQualificationRule(spec, from, to))}
          entries={spec.qualificationRules.map((rule, index) => {
            const ruleIssues = issuesFor(issues, ...qualificationRuleTokens(rule.ruleId, index));
            return {
              id: rule.ruleId,
              labelDe: rule.description,
              content: (
                <div className="flex flex-col gap-3 px-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        rule.effect === 'DISQUALIFY'
                          ? 'destructive'
                          : rule.effect === 'QUALIFY'
                            ? 'success'
                            : 'neutral'
                      }
                      size="sm"
                    >
                      {QUALIFICATION_EFFECT_LABELS_DE[rule.effect]}
                    </Badge>
                    <IssueMarker issues={ruleIssues} subjectDe={`Regel ${rule.ruleId}`} />
                    <span className="flex-1" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled}
                      aria-label={`Qualifizierungsregel „${rule.description}“ entfernen`}
                      onClick={() => onSpecChange(deleteQualificationRule(spec, rule.ruleId))}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <SelectControl
                      label="Wirkung"
                      value={rule.effect}
                      disabled={disabled}
                      hint={QUALIFICATION_EFFECT_HINTS_DE[rule.effect]}
                      options={EFFECTS.map((effect) => ({
                        value: effect,
                        labelDe: QUALIFICATION_EFFECT_LABELS_DE[effect],
                      }))}
                      onChange={(effect) =>
                        onSpecChange(changeQualificationEffect(spec, rule.ruleId, effect))
                      }
                    />
                    <TextControl
                      label="Grund-Code"
                      hint="Erscheint in Auswertungen und im CRM, nie auf der Ergebnisseite."
                      value={rule.reasonCode}
                      disabled={disabled}
                      onChange={(reasonCode) =>
                        onSpecChange(
                          updateQualificationRule(spec, rule.ruleId, (current) => ({
                            ...current,
                            reasonCode: reasonCode
                              .toUpperCase()
                              .replace(/[^A-Z0-9_]/g, '_')
                              .slice(0, 64),
                          })),
                        )
                      }
                    />
                  </div>

                  <TextControl
                    label="Beschreibung"
                    value={rule.description}
                    maxLength={300}
                    disabled={disabled}
                    onChange={(description) =>
                      onSpecChange(
                        updateQualificationRule(spec, rule.ruleId, (current) => ({
                          ...current,
                          description,
                        })),
                      )
                    }
                  />

                  {rule.effect === 'SCORE' ? (
                    <NumberControl
                      label="Punkte"
                      value={rule.points}
                      min={-100}
                      max={100}
                      disabled={disabled}
                      onChange={(points) =>
                        onSpecChange(
                          updateQualificationRule(spec, rule.ruleId, (current) =>
                            current.effect === 'SCORE' ? { ...current, points } : current,
                          ),
                        )
                      }
                    />
                  ) : null}

                  {rule.effect === 'CLASSIFY' ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <NumberControl
                        label="Ab dieser Punktzahl"
                        value={rule.minScore}
                        min={-1000}
                        max={1000}
                        disabled={disabled}
                        hint="Die zutreffende Regel mit dem höchsten Schwellenwert gewinnt."
                        onChange={(minScore) =>
                          onSpecChange(
                            updateQualificationRule(spec, rule.ruleId, (current) =>
                              current.effect === 'CLASSIFY' ? { ...current, minScore } : current,
                            ),
                          )
                        }
                      />
                      <SelectControl
                        label="Ergebnis"
                        value={rule.outcome}
                        disabled={disabled}
                        options={QUALIFICATION_OUTCOMES.map((outcome) => ({
                          value: outcome,
                          labelDe: QUALIFICATION_OUTCOME_LABELS_DE[outcome],
                        }))}
                        onChange={(outcome) =>
                          onSpecChange(
                            updateQualificationRule(spec, rule.ruleId, (current) =>
                              current.effect === 'CLASSIFY' ? { ...current, outcome } : current,
                            ),
                          )
                        }
                      />
                    </div>
                  ) : null}

                  {rule.when !== null ? (
                    <ConditionBuilder
                      spec={spec}
                      group={rule.when}
                      fromStepId={null}
                      disabled={disabled}
                      onChange={(when) =>
                        onSpecChange(
                          updateQualificationRule(spec, rule.ruleId, (current) => ({
                            ...current,
                            when,
                          })),
                        )
                      }
                    />
                  ) : (
                    <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                      Diese Einordnungsregel gilt für jede Einreichung, die die Punktzahl erreicht.
                    </p>
                  )}

                  <InlineIssues issues={ruleIssues} />
                </div>
              ),
            };
          })}
        />

        <InlineIssues
          issues={issues.filter((issue) => issue.pathDe.startsWith('Qualifizierung'))}
        />
      </div>
    </Section>
  );
}
