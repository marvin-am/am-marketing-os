'use client';

import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { VALIDATION_MESSAGES_DE } from '@am/domain';
import {
  computeProgress,
  entryStepId,
  evaluateQualification,
  getStep,
  nextTarget,
  selectResultVariant,
  validateAnswer,
  validateStep,
  visibleFields,
  type AnswerValue,
  type Answers,
  type FormField,
  type MultiStepFormSpec,
  type ResultVariant,
  type StepTarget,
} from '@am/funnel-schema';
import {
  cn,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Checkbox,
  Input,
  Label,
  Progress,
  RadioGroup,
  RadioGroupItem,
  Slider,
  Textarea,
} from '@am/ui';
import { NativeSelect } from '../controls';
import { RESULT_KIND_LABELS_DE } from '../labels';
import { PathInspector } from './path-inspector';
import { ViewportFrame } from './viewport-frame';

/**
 * An interactive walk through the form, driven by the shared engine.
 *
 * Every decision the preview makes is delegated: `visibleFields` decides what is
 * on screen, `validateAnswer` / `validateStep` decide whether the visitor may
 * continue, `nextTarget` decides where they go, `computeProgress` decides
 * whether a percentage may be shown at all, and `evaluateQualification` +
 * `selectResultVariant` decide which result they land on. Nothing about routing
 * or validation is reimplemented here, so a branch cannot behave one way in the
 * console and another way in the published funnel.
 *
 * The preview never submits anything: reaching `SUBMIT` renders the terminal
 * state the visitor would see and says explicitly that no data was sent.
 */

type Phase =
  | { kind: 'INTRO' }
  | { kind: 'STEP'; stepId: string }
  | { kind: 'RESULT'; variantId: string; reasonCode: string | null }
  | { kind: 'SUBMITTED' };

export interface FormPreviewProps {
  spec: MultiStepFormSpec;
  /** German note in the preview marker bar, e.g. the version state. */
  noteDe?: string;
  className?: string;
}

export function FormPreview({ spec, noteDe, className }: FormPreviewProps) {
  const [phase, setPhase] = React.useState<Phase>({ kind: 'INTRO' });
  const [answers, setAnswers] = React.useState<Answers>({});
  const [history, setHistory] = React.useState<string[]>([]);
  const [touched, setTouched] = React.useState<string[]>([]);
  const [stepErrors, setStepErrors] = React.useState<Record<string, string>>({});

  const currentStepId = phase.kind === 'STEP' ? phase.stepId : null;

  /* The operator keeps editing while the preview is open; a step that has just
     been deleted must not leave the preview on a blank screen. */
  React.useEffect(() => {
    if (phase.kind === 'STEP' && !getStep(spec, phase.stepId)) {
      setPhase({ kind: 'INTRO' });
      setHistory([]);
    }
  }, [spec, phase]);

  const reset = () => {
    setPhase({ kind: 'INTRO' });
    setAnswers({});
    setHistory([]);
    setTouched([]);
    setStepErrors({});
  };

  const setAnswer = (fieldId: string, value: AnswerValue) => {
    setAnswers((current) => ({ ...current, [fieldId]: value }));
    setStepErrors((current) => {
      if (!current[fieldId]) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  };

  const goToTarget = (target: StepTarget | null) => {
    if (!target) return;
    switch (target.kind) {
      case 'STEP': {
        if (currentStepId) setHistory((current) => [...current, currentStepId]);
        setPhase({ kind: 'STEP', stepId: target.stepId });
        setStepErrors({});
        break;
      }
      case 'SUBMIT':
        setPhase({ kind: 'SUBMITTED' });
        break;
      case 'RESULT':
        setPhase({ kind: 'RESULT', variantId: target.variantId, reasonCode: null });
        break;
      case 'DISQUALIFY':
        setPhase({
          kind: 'RESULT',
          variantId: target.variantId,
          reasonCode: target.reasonCode,
        });
        break;
      default:
        break;
    }
  };

  const handleNext = () => {
    if (!currentStepId) return;
    const result = validateStep(spec, currentStepId, answers);
    if (!result.ok) {
      setStepErrors(
        Object.fromEntries(result.errors.map((error) => [error.fieldId, error.messageDe])),
      );
      setTouched((current) => [
        ...current,
        ...result.errors.map((error) => error.fieldId),
      ]);
      return;
    }
    goToTarget(nextTarget(spec, currentStepId, answers));
  };

  const handleBack = () => {
    const previous = history[history.length - 1];
    if (!previous) {
      setPhase({ kind: 'INTRO' });
      return;
    }
    setHistory((current) => current.slice(0, -1));
    setPhase({ kind: 'STEP', stepId: previous });
    setStepErrors({});
  };

  const start = () => {
    const entry = entryStepId(spec);
    if (!entry) return;
    setPhase({ kind: 'STEP', stepId: entry });
    setHistory([]);
    setStepErrors({});
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-4', className)}>
      <ViewportFrame
        noteDe={noteDe}
        toolbarExtra={
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            <RotateCcw aria-hidden="true" />
            Vorschau zurücksetzen
          </Button>
        }
      >
        {phase.kind === 'INTRO' ? <IntroScreen spec={spec} onStart={start} /> : null}

        {phase.kind === 'STEP' ? (
          <StepScreen
            spec={spec}
            stepId={phase.stepId}
            answers={answers}
            touched={touched}
            stepErrors={stepErrors}
            canGoBack={history.length > 0}
            onAnswer={setAnswer}
            onTouch={(fieldId) => setTouched((current) => [...current, fieldId])}
            onNext={handleNext}
            onBack={handleBack}
          />
        ) : null}

        {phase.kind === 'RESULT' ? (
          <ResultScreen
            spec={spec}
            variantId={phase.variantId}
            reasonCode={phase.reasonCode}
            onRestart={reset}
          />
        ) : null}

        {phase.kind === 'SUBMITTED' ? (
          <SubmittedScreen spec={spec} answers={answers} onRestart={reset} />
        ) : null}
      </ViewportFrame>

      <PathInspector spec={spec} answers={answers} currentStepId={currentStepId} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Screens                                                                     */
/* -------------------------------------------------------------------------- */

function IntroScreen({ spec, onStart }: { spec: MultiStepFormSpec; onStart: () => void }) {
  const intro = spec.intro;
  return (
    <div className="flex flex-col gap-3">
      {intro.eyebrow ? (
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">{intro.eyebrow}</p>
      ) : null}
      <h2 className="text-lg font-semibold leading-tight text-foreground">{intro.headline}</h2>
      {intro.subline ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{intro.subline}</p>
      ) : null}
      {intro.bullets.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-foreground">
          {intro.bullets.map((bullet, index) => (
            <li key={index}>{bullet}</li>
          ))}
        </ul>
      ) : null}
      {intro.media ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          {`Medium: ${intro.media.assetPath} — ${intro.media.alt}`}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {intro.effortPromise ? (
          <Badge tone="neutral" size="sm">
            {intro.effortPromise}
          </Badge>
        ) : null}
      </div>
      <Button type="button" block onClick={onStart}>
        {intro.primaryCtaLabel}
      </Button>
      {intro.trustNote ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{intro.trustNote}</p>
      ) : null}
    </div>
  );
}

interface StepScreenProps {
  spec: MultiStepFormSpec;
  stepId: string;
  answers: Answers;
  touched: string[];
  stepErrors: Record<string, string>;
  canGoBack: boolean;
  onAnswer: (fieldId: string, value: AnswerValue) => void;
  onTouch: (fieldId: string) => void;
  onNext: () => void;
  onBack: () => void;
}

function StepScreen({
  spec,
  stepId,
  answers,
  touched,
  stepErrors,
  canGoBack,
  onAnswer,
  onTouch,
  onNext,
  onBack,
}: StepScreenProps) {
  const step = getStep(spec, stepId);
  if (!step) {
    return (
      <Alert tone="destructive">
        <AlertTitle>Schritt nicht gefunden</AlertTitle>
        <AlertDescription>
          {`Der Übergang zeigt auf den Schritt „${stepId}“, den es in dieser Version nicht gibt.`}
        </AlertDescription>
      </Alert>
    );
  }

  const fields = visibleFields(spec, step, answers);
  const progress = computeProgress(spec, stepId, answers);

  return (
    <div className="flex flex-col gap-4">
      {step.showProgress ? (
        <div className="flex flex-col gap-1">
          <Progress
            label="Fortschritt im Formular"
            value={
              progress.mode === 'exact' && progress.knownTotal
                ? (progress.stepIndex / progress.knownTotal) * 100
                : null
            }
          />
          <p className="text-xs text-muted-foreground">
            {progress.mode === 'exact' && progress.knownTotal
              ? `Schritt ${progress.stepIndex} von ${progress.knownTotal}`
              : `Schritt ${progress.stepIndex} — die Gesamtzahl hängt von Ihren Antworten ab`}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold leading-snug text-foreground">{step.title}</h2>
        {step.subtitle ? (
          <p className="text-sm leading-relaxed text-muted-foreground">{step.subtitle}</p>
        ) : null}
      </div>

      {fields.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          Dieser Schritt zeigt keine Frage.
        </p>
      ) : null}

      {fields.map((field) => (
        <PreviewField
          key={field.fieldId}
          spec={spec}
          field={field}
          value={answers[field.fieldId]}
          errorDe={errorFor(field, answers[field.fieldId], touched, stepErrors)}
          onChange={(value) => onAnswer(field.fieldId, value)}
          onBlur={() => onTouch(field.fieldId)}
        />
      ))}

      <div className="flex flex-col gap-2">
        <Button type="button" block onClick={onNext}>
          {step.primaryCtaLabel}
        </Button>
        {step.secondaryCtaLabel && canGoBack ? (
          <Button type="button" variant="ghost" block onClick={onBack}>
            {step.secondaryCtaLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function errorFor(
  field: FormField,
  value: AnswerValue,
  touched: string[],
  stepErrors: Record<string, string>,
): string | null {
  const submitted = stepErrors[field.fieldId];
  if (submitted) return submitted;
  if (!touched.includes(field.fieldId)) return null;
  const code = validateAnswer(field, value);
  return code ? VALIDATION_MESSAGES_DE[code] : null;
}

function ResultScreen({
  spec,
  variantId,
  reasonCode,
  onRestart,
}: {
  spec: MultiStepFormSpec;
  variantId: string;
  reasonCode: string | null;
  onRestart: () => void;
}) {
  const variant = spec.resultVariants.find((entry) => entry.variantId === variantId) ?? null;

  if (!variant) {
    return (
      <Alert tone="destructive">
        <AlertTitle>Ergebnisseite fehlt</AlertTitle>
        <AlertDescription>
          {`Der Übergang zeigt auf die Ergebnisvariante „${variantId}“, die es nicht gibt.`}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <VariantScreen variant={variant} />
      {reasonCode ? (
        <p className="text-xs text-muted-foreground">{`Interner Grund-Code: ${reasonCode}`}</p>
      ) : null}
      <Button type="button" variant="secondary" size="sm" onClick={onRestart}>
        Erneut durchgehen
      </Button>
    </div>
  );
}

function SubmittedScreen({
  spec,
  answers,
  onRestart,
}: {
  spec: MultiStepFormSpec;
  answers: Answers;
  onRestart: () => void;
}) {
  const qualification = evaluateQualification(spec, answers);
  const variant = selectResultVariant(spec, answers, qualification);

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">
        <AlertTitle>In der Vorschau wird nichts gesendet</AlertTitle>
        <AlertDescription>
          {`In der veröffentlichten Strecke ginge die Anfrage jetzt an ${spec.submit.endpointPath}.`}
        </AlertDescription>
      </Alert>

      {variant ? (
        <VariantScreen variant={variant} />
      ) : (
        <Alert tone="destructive">
          <AlertTitle>Keine passende Ergebnisseite</AlertTitle>
          <AlertDescription>
            Für dieses Qualifizierungsergebnis ist keine Ergebnisseite hinterlegt.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Bestätigung nach dem Absenden
        </p>
        <h3 className="text-sm font-semibold text-foreground">{spec.success.headline}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{spec.success.body}</p>
        {spec.success.booking ? (
          <p className="text-xs text-muted-foreground">
            {spec.success.booking.target
              ? `Terminbuchung: ${spec.success.booking.label}`
              : 'Terminbuchung noch nicht verbunden.'}
          </p>
        ) : null}
      </div>

      <Button type="button" variant="secondary" size="sm" onClick={onRestart}>
        Erneut durchgehen
      </Button>
    </div>
  );
}

function VariantScreen({ variant }: { variant: ResultVariant }) {
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="result-variant"
      data-variant-id={variant.variantId}
      data-variant-kind={variant.kind}
    >
      <Badge tone="neutral" size="sm">
        {RESULT_KIND_LABELS_DE[variant.kind]}
      </Badge>
      <h2 className="text-lg font-semibold leading-tight text-foreground">{variant.headline}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{variant.body}</p>

      {'bullets' in variant && variant.bullets.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {variant.bullets.map((bullet, index) => (
            <li key={index}>{bullet}</li>
          ))}
        </ul>
      ) : null}

      {variant.kind === 'ANALYSIS' ? (
        <div className="flex flex-col gap-2">
          {variant.sections.map((section) => (
            <div key={section.key} className="rounded-md border border-border p-2">
              <p className="text-sm font-semibold text-foreground">{section.title}</p>
              <p className="text-sm text-muted-foreground">{section.body}</p>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{variant.methodNote}</p>
        </div>
      ) : null}

      {variant.kind === 'NOT_A_FIT' ? (
        <p className="text-sm leading-relaxed text-foreground">{variant.alternativeNote}</p>
      ) : null}

      {variant.kind === 'LEAD_MAGNET' ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{variant.assetLabel}</p>
          <p className="text-xs text-muted-foreground">
            {variant.assetPath
              ? `Download: ${variant.assetPath}`
              : 'Unterlagen noch nicht hinterlegt — die Seite verspricht keinen Download.'}
          </p>
          <p className="text-xs text-muted-foreground">{variant.deliveryNote}</p>
        </div>
      ) : null}

      {'booking' in variant && variant.booking ? (
        <div className="rounded-md border border-border p-2 text-sm">
          <p className="font-medium">{variant.booking.label}</p>
          <p className="text-xs text-muted-foreground">
            {variant.booking.target
              ? `Ziel: ${variant.booking.target.href}`
              : 'Terminbuchung noch nicht verbunden.'}
          </p>
        </div>
      ) : null}

      {variant.kind === 'REDIRECT' ? (
        <p className="text-sm text-muted-foreground">
          {`Weiterleitung nach ${variant.delaySeconds} Sekunden auf ${variant.target.href}.`}
        </p>
      ) : null}

      {'cta' in variant && variant.cta ? (
        <Button type="button" variant="secondary" disabled title="In der Vorschau ohne Funktion">
          {variant.cta.label}
        </Button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

interface PreviewFieldProps {
  spec: MultiStepFormSpec;
  field: FormField;
  value: AnswerValue;
  errorDe: string | null;
  onChange: (value: AnswerValue) => void;
  onBlur: () => void;
}

function PreviewField({ spec, field, value, errorDe, onChange, onBlur }: PreviewFieldProps) {
  const controlId = React.useId();
  const errorId = `${controlId}-error`;
  const helpId = `${controlId}-help`;
  const describedBy =
    [field.helpText ? helpId : null, errorDe ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <fieldset className="flex flex-col gap-2 border-0 p-0">
      <legend className="text-sm font-medium leading-snug text-foreground">
        {field.label}
        {field.required ? <span className="text-destructive"> *</span> : null}
      </legend>
      {field.helpText ? (
        <p id={helpId} className="text-xs leading-relaxed text-muted-foreground">
          {field.helpText}
        </p>
      ) : null}

      <PreviewControl
        spec={spec}
        field={field}
        value={value}
        controlId={controlId}
        describedBy={describedBy}
        invalid={Boolean(errorDe)}
        onChange={onChange}
        onBlur={onBlur}
      />

      {errorDe ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {errorDe}
        </p>
      ) : null}
    </fieldset>
  );
}

interface PreviewControlProps extends Omit<PreviewFieldProps, 'errorDe'> {
  controlId: string;
  describedBy: string | undefined;
  invalid: boolean;
}

function PreviewControl({
  spec,
  field,
  value,
  controlId,
  describedBy,
  invalid,
  onChange,
  onBlur,
}: PreviewControlProps) {
  switch (field.type) {
    case 'SINGLE_SELECT': {
      if (field.display === 'DROPDOWN') {
        return (
          <NativeSelect
            id={controlId}
            value={typeof value === 'string' ? value : ''}
            invalid={invalid}
            aria-describedby={describedBy}
            onBlur={onBlur}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Bitte wählen</option>
            {field.options.map((option) => (
              <option key={option.optionId} value={option.optionId}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        );
      }
      return (
        <RadioGroup
          value={typeof value === 'string' ? value : ''}
          aria-describedby={describedBy}
          aria-label={field.label}
          onValueChange={(next) => {
            onChange(next);
            onBlur();
          }}
        >
          {field.options.map((option) => (
            <div
              key={option.optionId}
              className={cn(
                'flex items-start gap-3 rounded-md border border-border p-2',
                field.display === 'CARDS' && 'bg-surface',
              )}
            >
              <RadioGroupItem
                id={`${controlId}-${option.optionId}`}
                value={option.optionId}
                className="mt-0.5"
              />
              <div className="flex flex-col">
                <Label htmlFor={`${controlId}-${option.optionId}`} className="font-normal">
                  {option.label}
                </Label>
                {option.helpText ? (
                  <span className="text-xs text-muted-foreground">{option.helpText}</span>
                ) : null}
              </div>
            </div>
          ))}
        </RadioGroup>
      );
    }

    case 'MULTI_SELECT': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-col gap-1.5">
          {field.options.map((option) => (
            <div
              key={option.optionId}
              className="flex items-center gap-3 rounded-md border border-border p-2"
            >
              <Checkbox
                id={`${controlId}-${option.optionId}`}
                checked={selected.includes(option.optionId)}
                onCheckedChange={(next) => {
                  onChange(
                    next === true
                      ? [...selected, option.optionId]
                      : selected.filter((entry) => entry !== option.optionId),
                  );
                  onBlur();
                }}
              />
              <Label htmlFor={`${controlId}-${option.optionId}`} className="font-normal">
                {option.label}
              </Label>
            </div>
          ))}
        </div>
      );
    }

    case 'BOOLEAN':
      return (
        <RadioGroup
          value={value === true ? 'true' : value === false ? 'false' : ''}
          aria-label={field.label}
          aria-describedby={describedBy}
          onValueChange={(next) => {
            onChange(next === 'true');
            onBlur();
          }}
        >
          {[
            { key: 'true', labelDe: field.trueLabel },
            { key: 'false', labelDe: field.falseLabel },
          ].map((entry) => (
            <div key={entry.key} className="flex items-center gap-3 rounded-md border border-border p-2">
              <RadioGroupItem id={`${controlId}-${entry.key}`} value={entry.key} />
              <Label htmlFor={`${controlId}-${entry.key}`} className="font-normal">
                {entry.labelDe}
              </Label>
            </div>
          ))}
        </RadioGroup>
      );

    case 'NUMBER':
      return (
        <Input
          id={controlId}
          type="number"
          inputMode="numeric"
          min={field.min}
          max={field.max}
          step={field.step}
          value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'RANGE': {
      const current = typeof value === 'number' ? value : field.min;
      return (
        <div className="flex flex-col gap-1">
          <Slider
            value={[current]}
            min={field.min}
            max={field.max}
            step={field.step}
            thumbLabels={[field.label]}
            onValueChange={([next]) => onChange(next ?? field.min)}
            onValueCommit={onBlur}
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{field.minLabel ?? String(field.min)}</span>
            <span>{`${current}${field.unit ? ` ${field.unit}` : ''}`}</span>
            <span>{field.maxLabel ?? String(field.max)}</span>
          </div>
        </div>
      );
    }

    case 'LONG_TEXT':
      return (
        <Textarea
          id={controlId}
          rows={field.rows}
          maxLength={field.maxLength}
          placeholder={field.placeholder ?? undefined}
          value={typeof value === 'string' ? value : ''}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'CONSENT':
      return (
        <div className="flex items-start gap-3 rounded-md border border-border p-2">
          <Checkbox
            id={controlId}
            checked={value === true}
            aria-describedby={describedBy}
            onCheckedChange={(next) => {
              onChange(next === true);
              onBlur();
            }}
          />
          <Label htmlFor={controlId} className="font-normal leading-relaxed">
            {spec.consent.textDe}
          </Label>
        </div>
      );

    default:
      return (
        <Input
          id={controlId}
          type={field.type === 'EMAIL' ? 'email' : field.type === 'PHONE' ? 'tel' : 'text'}
          inputMode={
            field.type === 'POSTCODE' ? 'numeric' : field.type === 'EMAIL' ? 'email' : 'text'
          }
          maxLength={field.maxLength}
          placeholder={field.placeholder ?? undefined}
          value={typeof value === 'string' ? value : ''}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}
