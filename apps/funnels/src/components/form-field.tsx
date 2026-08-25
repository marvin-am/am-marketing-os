'use client';

/* The `@am/ui` barrel is deliberately not imported here: it re-exports every
   Radix-backed client component, and this is the critical path of a mobile ad
   click. Only the pure class-merge helper is pulled in. */
import { cn } from '@am/ui/lib/cn';
import {
  type AnswerValue,
  type FieldValidationError,
  type FormField,
  type MultiStepFormSpec,
} from '@am/funnel-schema';
import { describedBy, fieldDomId, fieldErrorDomId, fieldHelpDomId, optionDomId } from '@/lib/dom-ids';
import type { ResolvedTarget } from '@/server/redirect';

/**
 * One spec field, rendered.
 *
 * Everything here is native HTML. No combobox library, no custom listbox, no
 * portal: this is a mobile landing page whose conversion rate is measurably
 * sensitive to bundle size, and a native `<input type="radio">` is both smaller
 * and more accessible than any re-implementation of one.
 *
 * The non-negotiables, in markup terms:
 *
 * - every control has a real `<label for>`, an `aria-describedby` that carries
 *   help text and error, and `aria-invalid` when it is wrong;
 * - every hit target is at least 44 × 44 px (`min-h-11`, and the label is the
 *   target, not just the 20 px radio dot);
 * - controls are 16 px on small screens, because iOS zooms anything smaller on
 *   focus and a zoomed viewport is how a form starts scrolling sideways;
 * - `inputMode` and `autoComplete` are set per field type, which is the
 *   difference between a numeric keypad and a full keyboard for a postcode.
 */

export interface FormFieldControlProps {
  spec: MultiStepFormSpec;
  field: FormField;
  value: AnswerValue;
  error: FieldValidationError | null;
  onChange: (fieldId: string, value: AnswerValue) => void;
  onBlur: (fieldId: string) => void;
  /** Server-resolved privacy policy target for the consent field. */
  privacyTarget: ResolvedTarget | null;
}

const CONTROL_CLASS =
  'block min-h-11 w-full min-w-0 rounded-[var(--am-radius)] border border-input bg-surface px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--am-ring)]';

const CHOICE_CLASS =
  'flex min-h-11 w-full min-w-0 cursor-pointer items-start gap-3 rounded-[var(--am-radius)] border border-border bg-surface p-3 text-left has-[:checked]:border-brand has-[:checked]:bg-brand-subtle has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--am-ring)]';

const DOT_CLASS = 'mt-0.5 size-5 shrink-0 accent-[var(--am-brand)]';

/**
 * A company name is the one short-text field where autofill genuinely helps and
 * the spec has no slot to say so. Matching the generated field ids is a narrow,
 * documented heuristic rather than a guess about arbitrary author input.
 */
const ORGANIZATION_FIELD_IDS = new Set(['firma', 'unternehmen', 'company']);

function autoCompleteFor(field: FormField): string {
  switch (field.type) {
    case 'EMAIL':
      return 'email';
    case 'PHONE':
      return 'tel';
    case 'FIRST_NAME':
      return 'given-name';
    case 'LAST_NAME':
      return 'family-name';
    case 'POSTCODE':
      return 'postal-code';
    case 'SHORT_TEXT':
      return ORGANIZATION_FIELD_IDS.has(field.fieldId) ? 'organization' : 'on';
    default:
      return 'off';
  }
}

function asString(value: AnswerValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return '';
  return String(value);
}

function asList(value: AnswerValue): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

export function FormFieldControl({
  spec,
  field,
  value,
  error,
  onChange,
  onBlur,
  privacyTarget,
}: FormFieldControlProps) {
  const hasHelp = Boolean(field.helpText);
  const described = describedBy(field.fieldId, hasHelp, error !== null);
  const invalid = error !== null;

  const shared = {
    'aria-describedby': described,
    'aria-invalid': invalid || undefined,
    onBlur: () => onBlur(field.fieldId),
  } as const;

  const labelNode =
    field.type === 'CONSENT' ? null : (
      <label
        htmlFor={fieldDomId(field.fieldId)}
        className="block text-base font-medium text-foreground"
      >
        {field.label}
        {field.required ? (
          <span className="text-brand" aria-hidden="true">
            {' *'}
          </span>
        ) : null}
      </label>
    );

  let control: React.ReactNode = null;

  switch (field.type) {
    case 'SINGLE_SELECT': {
      const selected = asString(value);
      if (field.display === 'DROPDOWN') {
        control = (
          <select
            {...shared}
            id={fieldDomId(field.fieldId)}
            className={CONTROL_CLASS}
            value={selected}
            onChange={(event) => onChange(field.fieldId, event.target.value)}
          >
            <option value="">Bitte auswählen</option>
            {field.options.map((option) => (
              <option key={option.optionId} value={option.optionId}>
                {option.label}
              </option>
            ))}
          </select>
        );
        break;
      }
      control = (
        <fieldset className="min-w-0 border-0 p-0" aria-describedby={described}>
          <legend className="sr-only">{field.label}</legend>
          <div className="grid gap-2">
            {field.options.map((option, index) => (
              <label key={option.optionId} className={CHOICE_CLASS}>
                <input
                  type="radio"
                  id={index === 0 ? fieldDomId(field.fieldId) : optionDomId(field.fieldId, option.optionId)}
                  name={field.fieldId}
                  className={DOT_CLASS}
                  value={option.optionId}
                  checked={selected === option.optionId}
                  aria-invalid={invalid || undefined}
                  onChange={() => onChange(field.fieldId, option.optionId)}
                  onBlur={() => onBlur(field.fieldId)}
                />
                <span className="min-w-0">
                  <span className="block break-words text-base font-medium">{option.label}</span>
                  {option.helpText ? (
                    <span className="block break-words text-sm text-muted-foreground">
                      {option.helpText}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      );
      break;
    }

    case 'MULTI_SELECT': {
      const selected = asList(value);
      control = (
        <fieldset className="min-w-0 border-0 p-0" aria-describedby={described}>
          <legend className="sr-only">{field.label}</legend>
          <div className="grid gap-2">
            {field.options.map((option, index) => (
              <label key={option.optionId} className={CHOICE_CLASS}>
                <input
                  type="checkbox"
                  id={index === 0 ? fieldDomId(field.fieldId) : optionDomId(field.fieldId, option.optionId)}
                  name={field.fieldId}
                  className={DOT_CLASS}
                  value={option.optionId}
                  checked={selected.includes(option.optionId)}
                  aria-invalid={invalid || undefined}
                  onChange={(event) =>
                    onChange(
                      field.fieldId,
                      event.target.checked
                        ? [...selected, option.optionId]
                        : selected.filter((entry) => entry !== option.optionId),
                    )
                  }
                  onBlur={() => onBlur(field.fieldId)}
                />
                <span className="min-w-0">
                  <span className="block break-words text-base font-medium">{option.label}</span>
                  {option.helpText ? (
                    <span className="block break-words text-sm text-muted-foreground">
                      {option.helpText}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      );
      break;
    }

    case 'BOOLEAN': {
      const selected = asString(value);
      const choices = [
        { key: 'true', label: field.trueLabel },
        { key: 'false', label: field.falseLabel },
      ];
      control = (
        <fieldset className="min-w-0 border-0 p-0" aria-describedby={described}>
          <legend className="sr-only">{field.label}</legend>
          <div className="grid gap-2">
            {choices.map((choice, index) => (
              <label key={choice.key} className={CHOICE_CLASS}>
                <input
                  type="radio"
                  id={index === 0 ? fieldDomId(field.fieldId) : optionDomId(field.fieldId, choice.key)}
                  name={field.fieldId}
                  className={DOT_CLASS}
                  value={choice.key}
                  checked={selected === choice.key}
                  aria-invalid={invalid || undefined}
                  onChange={() => onChange(field.fieldId, choice.key === 'true')}
                  onBlur={() => onBlur(field.fieldId)}
                />
                <span className="min-w-0 break-words text-base font-medium">{choice.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
      break;
    }

    case 'NUMBER':
      control = (
        <div className="flex min-w-0 items-center gap-2">
          <input
            {...shared}
            id={fieldDomId(field.fieldId)}
            className={CONTROL_CLASS}
            type="number"
            inputMode="decimal"
            autoComplete="off"
            min={field.min}
            max={field.max}
            step={field.step}
            value={asString(value)}
            placeholder={field.placeholder ?? undefined}
            onChange={(event) => onChange(field.fieldId, event.target.value)}
          />
          {field.unit ? (
            <span className="shrink-0 text-base text-muted-foreground">{field.unit}</span>
          ) : null}
        </div>
      );
      break;

    case 'RANGE': {
      const current = asString(value) === '' ? String(field.min) : asString(value);
      control = (
        <div className="min-w-0">
          <input
            {...shared}
            id={fieldDomId(field.fieldId)}
            className="h-11 w-full min-w-0 accent-[var(--am-brand)]"
            type="range"
            min={field.min}
            max={field.max}
            step={field.step}
            value={current}
            onChange={(event) => onChange(field.fieldId, Number(event.target.value))}
          />
          <div className="flex justify-between gap-2 text-sm text-muted-foreground">
            <span className="min-w-0 break-words">{field.minLabel ?? field.min}</span>
            <output htmlFor={fieldDomId(field.fieldId)} className="font-medium text-foreground">
              {current}
              {field.unit ? ` ${field.unit}` : ''}
            </output>
            <span className="min-w-0 break-words">{field.maxLabel ?? field.max}</span>
          </div>
        </div>
      );
      break;
    }

    case 'LONG_TEXT':
      control = (
        <textarea
          {...shared}
          id={fieldDomId(field.fieldId)}
          className={cn(CONTROL_CLASS, 'resize-y')}
          rows={field.rows}
          maxLength={field.maxLength}
          autoComplete="off"
          value={asString(value)}
          placeholder={field.placeholder ?? undefined}
          onChange={(event) => onChange(field.fieldId, event.target.value)}
        />
      );
      break;

    case 'CONSENT':
      control = (
        <label className="flex min-h-11 w-full min-w-0 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            id={fieldDomId(field.fieldId)}
            className={DOT_CLASS}
            /* Never pre-ticked. `spec.consent.defaultChecked` is a `false`
               literal in the schema; this is the runtime half of that promise. */
            checked={value === true || value === 'true'}
            aria-describedby={described}
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange(field.fieldId, event.target.checked)}
            onBlur={() => onBlur(field.fieldId)}
          />
          <span className="min-w-0 break-words text-sm text-foreground">
            {spec.consent.textDe}{' '}
            {privacyTarget?.allowed ? (
              <a
                className="underline underline-offset-2"
                href={privacyTarget.href}
                target={privacyTarget.newTab ? '_blank' : undefined}
                rel={privacyTarget.newTab ? 'noopener noreferrer' : undefined}
              >
                Datenschutzerklärung
              </a>
            ) : null}
          </span>
        </label>
      );
      break;

    default:
      control = (
        <input
          {...shared}
          id={fieldDomId(field.fieldId)}
          className={CONTROL_CLASS}
          type={field.type === 'EMAIL' ? 'email' : field.type === 'PHONE' ? 'tel' : 'text'}
          inputMode={
            field.type === 'EMAIL'
              ? 'email'
              : field.type === 'PHONE'
                ? 'tel'
                : field.type === 'POSTCODE'
                  ? 'numeric'
                  : undefined
          }
          pattern={field.type === 'POSTCODE' ? '[0-9]*' : undefined}
          maxLength={field.maxLength}
          autoComplete={autoCompleteFor(field)}
          value={asString(value)}
          placeholder={field.placeholder ?? undefined}
          onChange={(event) => onChange(field.fieldId, event.target.value)}
        />
      );
  }

  return (
    <div className="grid min-w-0 gap-2" data-field={field.fieldId}>
      {labelNode}
      {field.helpText ? (
        <p id={fieldHelpDomId(field.fieldId)} className="break-words text-sm text-muted-foreground">
          {field.helpText}
        </p>
      ) : null}
      {control}
      {error ? (
        <p
          id={fieldErrorDomId(field.fieldId)}
          role="alert"
          className="break-words text-sm font-medium text-destructive"
        >
          {error.messageDe}
        </p>
      ) : null}
    </div>
  );
}
