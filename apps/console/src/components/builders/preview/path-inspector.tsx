'use client';

import {
  evaluateCondition,
  evaluateQualification,
  getStep,
  pathFor,
  routingRulesFor,
  selectResultVariant,
  QUALIFICATION_OUTCOME_LABELS_DE,
  type Answers,
  type MultiStepFormSpec,
} from '@am/funnel-schema';
import { Alert, AlertDescription, AlertTitle, Badge, Section } from '@am/ui';
import { RESULT_KIND_LABELS_DE } from '../labels';
import { describeTarget } from '../form/form-ops';

/**
 * Why the preview went where it went.
 *
 * Everything here is read straight out of the engine — `pathFor`,
 * `evaluateCondition`, `evaluateQualification`, `selectResultVariant` — so the
 * explanation cannot disagree with the behaviour it explains. This is the panel
 * an operator opens when a branch "does not work": it names the rule that fired,
 * the rules that did not, the score and the variant that won.
 */

export interface PathInspectorProps {
  spec: MultiStepFormSpec;
  answers: Answers;
  currentStepId: string | null;
}

export function PathInspector({ spec, answers, currentStepId }: PathInspectorProps) {
  const path = pathFor(spec, answers);
  const qualification = evaluateQualification(spec, answers);
  const variant = selectResultVariant(spec, answers, qualification);

  return (
    <Section
      heading="Berechneter Pfad"
      headingLevel={3}
      description="Ergebnis derselben Funktionen, die auch die öffentliche Strecke und der Server verwenden."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Schrittfolge mit den bisherigen Antworten
          </p>
          <ol className="flex flex-wrap items-center gap-1.5">
            {path.stepIds.map((stepId) => {
              const step = getStep(spec, stepId);
              return (
                <li key={stepId}>
                  <Badge tone={stepId === currentStepId ? 'brand' : 'neutral'} size="sm">
                    {step?.title ?? stepId}
                  </Badge>
                </li>
              );
            })}
            {path.terminal ? (
              <li>
                <Badge tone="success" size="sm">
                  {describeTarget(spec, path.terminal)}
                </Badge>
              </li>
            ) : null}
          </ol>
          {path.truncated ? (
            <Alert tone="destructive">
              <AlertTitle>Pfad nicht berechenbar</AlertTitle>
              <AlertDescription>
                Die Schrittfolge endet in einem Kreis oder zeigt auf einen Schritt, den es nicht
                gibt. Prüfen Sie die Übergänge der markierten Schritte.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Geprüfte Verzweigungsregeln
          </p>
          {path.stepIds.flatMap((stepId) => routingRulesFor(spec, stepId)).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Auf diesem Pfad ist keine Verzweigungsregel hinterlegt.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {path.stepIds.map((stepId) => {
                const rules = routingRulesFor(spec, stepId);
                let alreadyMatched = false;
                return rules.map((rule) => {
                  const matches = evaluateCondition(rule.when, answers);
                  const fired = matches && !alreadyMatched;
                  if (matches) alreadyMatched = true;
                  return (
                    <li
                      key={rule.ruleId}
                      data-fired={fired ? 'true' : 'false'}
                      className="rounded-md border border-border p-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={fired ? 'success' : 'neutral'} size="sm">
                          {fired ? 'greift' : matches ? 'überstimmt' : 'greift nicht'}
                        </Badge>
                        <span className="font-medium">{rule.description}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {`Ab „${getStep(spec, stepId)?.title ?? stepId}“ → ${describeTarget(spec, rule.target)}`}
                      </p>
                    </li>
                  );
                });
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Qualifizierung
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                qualification.outcome === 'QUALIFIED'
                  ? 'success'
                  : qualification.outcome === 'NOT_A_FIT'
                    ? 'destructive'
                    : 'warning'
              }
              size="sm"
            >
              {QUALIFICATION_OUTCOME_LABELS_DE[qualification.outcome]}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {`${qualification.score} Punkte`}
            </span>
          </div>
          {qualification.reasonCodes.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {`Gründe: ${qualification.reasonCodes.join(', ')}`}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Ausgewählte Ergebnisseite
          </p>
          {variant ? (
            <p className="text-sm" data-testid="selected-variant" data-variant-id={variant.variantId}>
              {`${variant.headline} (${RESULT_KIND_LABELS_DE[variant.kind]})`}
            </p>
          ) : (
            <p className="text-sm text-destructive">
              Keine Ergebnisseite passt zu diesem Ergebnis.
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}
