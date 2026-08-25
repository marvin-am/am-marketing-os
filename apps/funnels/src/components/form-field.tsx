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
 * - every control is named — a `<label for>` for a single control, a
 *   `<fieldset>` and `<legend>` for a group of them — and carries an
 *   `aria-describedby` with help text and error plus `aria-invalid` when it is
 *   wrong;
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

interface ChoiceOptionView {
  /** The value written to the answer, and the suffix of the option's DOM id. */
  key: string;
  label: string;
  helpText: string | null;
}

interface ChoiceGroupProps {
  fieldId: string;
  /** The question. Names the group, and nothing else. */
  legend: string;
  type: 'radio' | 'checkbox';
  options: readonly ChoiceOptionView[];
  isSelected: (key: string) => boolean;
  onToggle: (key: string, checked: boolean) => void;
  onBlur: () => void;
  describedBy: string | undefined;
  invalid: boolean;
}

/**
 * Radio and checkbox groups — the one control on this form built out of several
 * inputs, and therefore the one where a name can land on the wrong element.
 *
 * The question names the *group*, through the `<legend>`. It must never reach a
 * single option: an option that borrows the field id from the caption above
 * announces as "<question> <option>" while its siblings announce as "<option>",
 * and a tap on the question — which reads as inert text — silently selects that
 * option and sends it along with the lead.
 */
function ChoiceGroup({
  fieldId,
  legend,
  type,
  options,
  isSelected,
  onToggle,
  onBlur,
  describedBy,
  invalid,
}: ChoiceGroupProps) {
  return (
    /* The caption above points its `for` at this id. A `<fieldset>` is not a
       labelable element, so the reference names the group for a reader without
       ever turning the question into a control's label. */
    <fieldset id={fieldDomId(fieldId)} className="min-w-0 border-0 p-0">
      <legend className="sr-only">{legend}</legend>
      <div className="grid gap-2">
        {options.map((option) => (
          <label key={option.key} className={CHOICE_CLASS}>
            <input
              type={type}
              id={optionDomId(fieldId, option.key)}
              name={fieldId}
              className={DOT_CLASS}
              value={option.key}
              checked={isSelected(option.key)}
              /* Help text and error hang off the inputs rather than off the
                 fieldset: a failed step moves focus to a control, and a
                 description the focused control does not carry is one no screen
                 reader announces. */
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(event) => onToggle(option.key, event.target.checked)}
              onBlur={onBlur}
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

  /* `fieldDomId` identifies the field's control: the input, the select, or —
     for a choice field — the `<fieldset>` around its options. */
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
        <ChoiceGroup
          fieldId={field.fieldId}
          legend={field.label}
          type="radio"
          options={field.options.map((option) => ({
            key: option.optionId,
            label: option.label,
            helpText: option.helpText ?? null,
          }))}
          isSelected={(key) => selected === key}
          onToggle={(key) => onChange(field.fieldId, key)}
          onBlur={() => onBlur(field.fieldId)}
          describedBy={described}
          invalid={invalid}
        />
      );
      break;
    }

    case 'MULTI_SELECT': {
      const selected = asList(value);
      control = (
        <ChoiceGroup
          fieldId={field.fieldId}
          legend={field.label}
          type="checkbox"
          options={field.options.map((option) => ({
            key: option.optionId,
            label: option.label,
            helpText: option.helpText ?? null,
          }))}
          isSelected={(key) => selected.includes(key)}
          onToggle={(key, checked) =>
            onChange(
              field.fieldId,
              checked ? [...selected, key] : selected.filter((entry) => entry !== key),
            )
          }
          onBlur={() => onBlur(field.fieldId)}
          describedBy={described}
          invalid={invalid}
        />
      );
      break;
    }

    case 'BOOLEAN': {
      const selected = asString(value);
      control = (
        <ChoiceGroup
          fieldId={field.fieldId}
          legend={field.label}
          type="radio"
          options={[
            { key: 'true', label: field.trueLabel, helpText: null },
            { key: 'false', label: field.falseLabel, helpText: null },
          ]}
          isSelected={(key) => selected === key}
          onToggle={(key) => onChange(field.fieldId, key === 'true')}
          onBlur={() => onBlur(field.fieldId)}
          describedBy={described}
          invalid={invalid}
        />
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
