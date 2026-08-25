'use client';

import * as React from 'react';
import type { MultiStepFormSpec, StepTarget, ValidationIssue } from '@am/funnel-schema';
import { cn, Input, Label } from '@am/ui';
import { NativeSelect } from '../controls';
import { InlineIssues } from '../issue-views';
import { TARGET_KIND_LABELS_DE } from '../labels';
import { createTarget } from './form-ops';

/**
 * Where a transition leads.
 *
 * Four kinds, three of them terminal. The picker never lets an operator type an
 * id: steps and result variants come from dropdowns over the current document,
 * and the reason code is normalised to the `GROSS_MIT_UNTERSTRICH` shape while
 * it is typed, so an unusable code cannot be produced.
 */

export interface TargetPickerProps {
  spec: MultiStepFormSpec;
  target: StepTarget;
  onChange: (target: StepTarget) => void;
  labelDe: string;
  hintDe?: string;
  disabled?: boolean;
  issues?: readonly ValidationIssue[];
  /** Steps that must not be offered — a step never routes to itself. */
  excludeStepId?: string | null;
  className?: string;
}

export function TargetPicker({
  spec,
  target,
  onChange,
  labelDe,
  hintDe,
  disabled = false,
  issues = [],
  excludeStepId = null,
  className,
}: TargetPickerProps) {
  const baseId = React.useId();
  const steps = spec.steps.filter((step) => step.stepId !== excludeStepId);

  /* Switching to "weiter zu Schritt" must land on a step this transition may
     actually reach — otherwise the select would show one step while the document
     stored another, and the operator would debug a cycle they never chose. */
  const changeKind = (kind: StepTarget['kind']) => {
    const next = createTarget(spec, kind);
    if (next.kind !== 'STEP') {
      onChange(next);
      return;
    }
    onChange({ kind: 'STEP', stepId: steps[0]?.stepId ?? next.stepId });
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${baseId}-kind`}>{labelDe}</Label>
        <NativeSelect
          id={`${baseId}-kind`}
          value={target.kind}
          disabled={disabled}
          onChange={(event) => changeKind(event.target.value as StepTarget['kind'])}
        >
          {(Object.keys(TARGET_KIND_LABELS_DE) as StepTarget['kind'][]).map((kind) => (
            <option key={kind} value={kind}>
              {TARGET_KIND_LABELS_DE[kind]}
            </option>
          ))}
        </NativeSelect>
        {hintDe ? <p className="text-xs text-muted-foreground">{hintDe}</p> : null}
      </div>

      {target.kind === 'STEP' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${baseId}-step`}>Zielschritt</Label>
          <NativeSelect
            id={`${baseId}-step`}
            value={target.stepId}
            disabled={disabled}
            onChange={(event) => onChange({ kind: 'STEP', stepId: event.target.value })}
          >
            {steps.length === 0 ? <option value="">Kein weiterer Schritt vorhanden</option> : null}
            {steps.map((step) => (
              <option key={step.stepId} value={step.stepId}>
                {step.title}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      {target.kind === 'RESULT' || target.kind === 'DISQUALIFY' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${baseId}-variant`}>Ergebnisvariante</Label>
          <NativeSelect
            id={`${baseId}-variant`}
            value={target.variantId}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                target.kind === 'RESULT'
                  ? { kind: 'RESULT', variantId: event.target.value }
                  : {
                      kind: 'DISQUALIFY',
                      variantId: event.target.value,
                      reasonCode: target.reasonCode,
                    },
              )
            }
          >
            {spec.resultVariants.length === 0 ? (
              <option value="">Noch keine Ergebnisvariante angelegt</option>
            ) : null}
            {spec.resultVariants.map((variant) => (
              <option key={variant.variantId} value={variant.variantId}>
                {variant.headline}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      {target.kind === 'DISQUALIFY' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${baseId}-reason`}>Grund-Code für die Auswertung</Label>
          <Input
            id={`${baseId}-reason`}
            value={target.reasonCode}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                kind: 'DISQUALIFY',
                variantId: target.variantId,
                reasonCode: event.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9_]/g, '_')
                  .slice(0, 64),
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Wird nur intern ausgewertet und nie an Besucherinnen und Besucher ausgeliefert.
          </p>
        </div>
      ) : null}

      <InlineIssues issues={issues} />
    </div>
  );
}
