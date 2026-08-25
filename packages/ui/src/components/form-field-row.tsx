'use client';

import * as React from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '../lib/cn';
import { Label } from './label';

export interface FormFieldRenderProps {
  /** Id to put on the control; already referenced by the label. */
  id: string;
  /** Space-separated ids of the error and help texts, or `undefined`. */
  describedBy: string | undefined;
  invalid: boolean;
  errorId: string | undefined;
  helpId: string | undefined;
}

export interface FormFieldRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** German field label. */
  label: React.ReactNode;
  /** Control. Either a single element (props are injected) or a render prop. */
  children: React.ReactNode | ((props: FormFieldRenderProps) => React.ReactNode);
  /** German help text, always rendered below the control. */
  help?: React.ReactNode;
  /** German validation message. Its presence sets `aria-invalid` on the control. */
  error?: React.ReactNode | null;
  required?: boolean;
  /** Supply a stable id when the control needs one from outside. */
  id?: string;
  /** Label above (default) or beside the control. */
  orientation?: 'vertical' | 'horizontal';
  /** Keep the label available to assistive tech but hide it visually. */
  hideLabel?: boolean;
}

/**
 * The one way a labelled form control is assembled.
 *
 * It owns the id, wires `aria-describedby` to the help *and* error text and
 * sets `aria-invalid` whenever an error is present — so a validation message
 * is never a red sentence that a screen reader cannot connect to its field.
 */
export const FormFieldRow = React.forwardRef<HTMLDivElement, FormFieldRowProps>(
  function FormFieldRow(
    {
      className,
      label,
      children,
      help,
      error = null,
      required = false,
      id,
      orientation = 'vertical',
      hideLabel = false,
      ...props
    },
    ref,
  ) {
    const generatedId = React.useId();
    const controlId = id ?? generatedId;
    const hasError = error !== null && error !== undefined && error !== false && error !== '';
    const errorId = hasError ? `${controlId}-error` : undefined;
    const helpId = help ? `${controlId}-help` : undefined;
    const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;

    const renderProps: FormFieldRenderProps = {
      id: controlId,
      describedBy,
      invalid: hasError,
      errorId,
      helpId,
    };

    let control: React.ReactNode;
    if (typeof children === 'function') {
      control = children(renderProps);
    } else if (React.isValidElement(children)) {
      const child = children as React.ReactElement<Record<string, unknown>>;
      const childProps = child.props;
      const mergedDescribedBy =
        [childProps['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined;
      control = React.cloneElement(child, {
        id: (childProps.id as string | undefined) ?? controlId,
        'aria-describedby': mergedDescribedBy,
        'aria-invalid': hasError ? true : childProps['aria-invalid'],
        'aria-required': required ? true : childProps['aria-required'],
      });
    } else {
      control = children;
    }

    return (
      <div
        ref={ref}
        data-invalid={hasError ? '' : undefined}
        className={cn(
          'flex gap-1.5',
          orientation === 'horizontal'
            ? 'flex-col sm:grid sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:items-start sm:gap-x-4'
            : 'flex-col',
          className,
        )}
        {...props}
      >
        <Label
          htmlFor={controlId}
          required={required}
          className={cn(
            hideLabel && 'sr-only',
            orientation === 'horizontal' && 'sm:pt-3',
          )}
        >
          {label}
        </Label>

        <div className="flex min-w-0 flex-col gap-1.5">
          {control}

          {hasError ? (
            <p
              id={errorId}
              role="alert"
              className="flex items-start gap-1.5 text-xs font-medium leading-relaxed text-destructive"
            >
              <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}

          {help ? (
            <p id={helpId} className="text-xs leading-relaxed text-muted-foreground">
              {help}
            </p>
          ) : null}
        </div>
      </div>
    );
  },
);
