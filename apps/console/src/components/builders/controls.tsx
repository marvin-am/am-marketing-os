'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  cn,
  Button,
  Checkbox,
  Input,
  inputVariants,
  Label,
  Switch,
  Textarea,
} from '@am/ui';
import { hasBlockingIssues, type ValidationIssue } from '@am/funnel-schema';
import { InlineIssues } from './issue-views';

/**
 * The labelled controls both builders are assembled from.
 *
 * Three properties every control here guarantees, because the builders have
 * dozens of them and per-call-site discipline would not hold:
 *
 * - a visible German `<label>` bound to the control (never a placeholder as a
 *   label),
 * - `aria-describedby` wired to the hint *and* to the inline validation issues,
 *   so a screen reader reads the problem with the field rather than after it,
 * - `aria-invalid` driven by the validator's severity, not by local state.
 *
 * `NativeSelect` is composed here rather than taken from `@am/ui`: the design
 * system ships a Radix listbox, which is the right control for a page-level
 * filter but needs pointer geometry and a portal. Inside a dense three-pane
 * editor with dozens of selects per screen, the platform `<select>` is smaller,
 * faster and keyboard-native. It reuses `inputVariants`, so it looks identical.
 */

/* -------------------------------------------------------------------------- */
/* Native select                                                               */
/* -------------------------------------------------------------------------- */

export interface NativeSelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  selectSize?: 'sm' | 'md' | 'lg';
  invalid?: boolean;
}

export const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  function NativeSelect({ className, selectSize = 'md', invalid, ...props }, ref) {
    return (
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          inputVariants({ inputSize: selectSize, tone: invalid ? 'invalid' : 'default' }),
          'cursor-pointer appearance-none bg-surface pr-8',
          className,
        )}
        {...props}
      />
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

export interface ControlShellProps {
  label: string;
  hint?: string;
  issues?: readonly ValidationIssue[];
  className?: string;
  /** Rendered right of the label, e.g. a frozen-id badge. */
  labelAside?: React.ReactNode;
  children: (ids: { controlId: string; describedBy: string | undefined; invalid: boolean }) => React.ReactNode;
}

export function ControlShell({
  label,
  hint,
  issues = [],
  className,
  labelAside,
  children,
}: ControlShellProps) {
  const controlId = React.useId();
  const hintId = `${controlId}-hint`;
  const issuesId = `${controlId}-issues`;
  const describedBy =
    [hint ? hintId : null, issues.length > 0 ? issuesId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={controlId}>{label}</Label>
        {labelAside}
      </div>
      {children({ controlId, describedBy, invalid: hasBlockingIssues(issues) })}
      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <InlineIssues id={issuesId} issues={issues} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

export interface TextControlProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  issues?: readonly ValidationIssue[];
  disabled?: boolean;
  maxLength?: number;
  className?: string;
  labelAside?: React.ReactNode;
}

export function TextControl({
  label,
  value,
  onChange,
  hint,
  placeholder,
  issues,
  disabled,
  maxLength,
  className,
  labelAside,
}: TextControlProps) {
  return (
    <ControlShell
      label={label}
      hint={hint}
      issues={issues}
      className={className}
      labelAside={labelAside}
    >
      {({ controlId, describedBy, invalid }) => (
        <Input
          id={controlId}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          tone={invalid ? 'invalid' : 'default'}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </ControlShell>
  );
}

export interface TextareaControlProps extends Omit<TextControlProps, 'placeholder'> {
  rows?: number;
  placeholder?: string;
}

export function TextareaControl({
  label,
  value,
  onChange,
  hint,
  placeholder,
  issues,
  disabled,
  maxLength,
  rows = 3,
  className,
}: TextareaControlProps) {
  return (
    <ControlShell label={label} hint={hint} issues={issues} className={className}>
      {({ controlId, describedBy, invalid }) => (
        <Textarea
          id={controlId}
          rows={rows}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </ControlShell>
  );
}

/**
 * Optional German copy. The spec models "not set" as `null`, never as an empty
 * string, so the control converts on the way out.
 */
export function OptionalTextControl(props: Omit<TextControlProps, 'value' | 'onChange'> & {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const { value, onChange, ...rest } = props;
  return (
    <TextControl
      {...rest}
      value={value ?? ''}
      onChange={(next) => onChange(next.trim().length === 0 ? null : next)}
    />
  );
}

export function OptionalTextareaControl(
  props: Omit<TextareaControlProps, 'value' | 'onChange'> & {
    value: string | null;
    onChange: (value: string | null) => void;
  },
) {
  const { value, onChange, ...rest } = props;
  return (
    <TextareaControl
      {...rest}
      value={value ?? ''}
      onChange={(next) => onChange(next.trim().length === 0 ? null : next)}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Number                                                                      */
/* -------------------------------------------------------------------------- */

export interface NumberControlProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint?: string;
  issues?: readonly ValidationIssue[];
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}

export function NumberControl({
  label,
  value,
  onChange,
  hint,
  issues,
  disabled,
  min,
  max,
  step,
  className,
}: NumberControlProps) {
  return (
    <ControlShell label={label} hint={hint} issues={issues} className={className}>
      {({ controlId, describedBy, invalid }) => (
        <Input
          id={controlId}
          type="number"
          inputMode="numeric"
          value={Number.isFinite(value) ? String(value) : ''}
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          tone={invalid ? 'invalid' : 'default'}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            onChange(Number.isFinite(parsed) ? parsed : 0);
          }}
        />
      )}
    </ControlShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Select                                                                      */
/* -------------------------------------------------------------------------- */

export interface SelectOption<T extends string> {
  value: T;
  labelDe: string;
  disabled?: boolean;
}

export interface SelectControlProps<T extends string> {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  hint?: string;
  issues?: readonly ValidationIssue[];
  disabled?: boolean;
  className?: string;
}

export function SelectControl<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  issues,
  disabled,
  className,
}: SelectControlProps<T>) {
  return (
    <ControlShell label={label} hint={hint} issues={issues} className={className}>
      {({ controlId, describedBy, invalid }) => (
        <NativeSelect
          id={controlId}
          value={value}
          disabled={disabled}
          invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.labelDe}
            </option>
          ))}
        </NativeSelect>
      )}
    </ControlShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Boolean                                                                     */
/* -------------------------------------------------------------------------- */

export interface SwitchControlProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  issues?: readonly ValidationIssue[];
  disabled?: boolean;
  className?: string;
}

export function SwitchControl({
  label,
  checked,
  onChange,
  hint,
  issues = [],
  disabled,
  className,
}: SwitchControlProps) {
  const controlId = React.useId();
  const hintId = `${controlId}-hint`;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={controlId}>{label}</Label>
        <Switch
          id={controlId}
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onCheckedChange={onChange}
        />
      </div>
      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <InlineIssues issues={issues} />
    </div>
  );
}

export interface CheckboxGroupControlProps<T extends string> {
  label: string;
  values: readonly T[];
  options: readonly SelectOption<T>[];
  onChange: (values: T[]) => void;
  hint?: string;
  issues?: readonly ValidationIssue[];
  disabled?: boolean;
  className?: string;
}

export function CheckboxGroupControl<T extends string>({
  label,
  values,
  options,
  onChange,
  hint,
  issues = [],
  disabled,
  className,
}: CheckboxGroupControlProps<T>) {
  const groupId = React.useId();

  return (
    <fieldset className={cn('flex min-w-0 flex-col gap-1.5', className)} disabled={disabled}>
      <legend className="text-sm font-medium leading-none text-foreground">{label}</legend>
      {hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
      <div className="flex flex-col gap-1.5 pt-1">
        {options.map((option) => {
          const id = `${groupId}-${option.value}`;
          const checked = values.includes(option.value);
          return (
            <div key={option.value} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={checked}
                disabled={disabled || option.disabled}
                onCheckedChange={(next) => {
                  const isChecked = next === true;
                  onChange(
                    isChecked
                      ? [...values.filter((entry) => entry !== option.value), option.value]
                      : values.filter((entry) => entry !== option.value),
                  );
                }}
              />
              <Label htmlFor={id} className="font-normal">
                {option.labelDe}
              </Label>
            </div>
          );
        })}
      </div>
      <InlineIssues issues={issues} />
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* String list                                                                 */
/* -------------------------------------------------------------------------- */

export interface StringListControlProps {
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  hint?: string;
  issues?: readonly ValidationIssue[];
  disabled?: boolean;
  /** German noun in the add button, e.g. „Stichpunkt“. */
  itemNounDe: string;
  maxItems?: number;
  className?: string;
}

/** Bullet lists, disclaimers, analysis bullets — an ordered list of German copy. */
export function StringListControl({
  label,
  values,
  onChange,
  hint,
  issues = [],
  disabled,
  itemNounDe,
  maxItems = 6,
  className,
}: StringListControlProps) {
  const groupId = React.useId();

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium leading-none text-foreground">{label}</span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || values.length >= maxItems}
          onClick={() => onChange([...values, `Neuer ${itemNounDe}`])}
        >
          <Plus aria-hidden="true" />
          {itemNounDe} hinzufügen
        </Button>
      </div>
      {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">Noch kein Eintrag.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {values.map((entry, index) => (
            <li key={`${groupId}-${index}`} className="flex items-center gap-2">
              <Label htmlFor={`${groupId}-${index}`} className="sr-only">
                {`${itemNounDe} ${index + 1}`}
              </Label>
              <Input
                id={`${groupId}-${index}`}
                value={entry}
                disabled={disabled}
                onChange={(event) => {
                  const next = [...values];
                  next[index] = event.target.value;
                  onChange(next);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={`${itemNounDe} ${index + 1} entfernen`}
                onClick={() => onChange(values.filter((_, position) => position !== index))}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <InlineIssues issues={issues} />
    </div>
  );
}
