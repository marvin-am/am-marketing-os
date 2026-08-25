'use client';

import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { cn } from '../lib/cn';

export const RadioGroup = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(function RadioGroup({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Root ref={ref} className={cn('grid gap-1', className)} {...props} />
  );
});

export const RadioGroupItem = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(function RadioGroupItem({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-input bg-surface',
        'transition-[border-color,box-shadow] duration-150',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-brand',
        'aria-[invalid=true]:border-destructive',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="block size-2.5 rounded-full bg-brand" />
    </RadioGroupPrimitive.Item>
  );
});

export interface RadioFieldProps
  extends React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item> {
  label: React.ReactNode;
  description?: React.ReactNode;
}

/** A radio plus its German label, laid out as a 44 px-tall target row. */
export const RadioField = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  RadioFieldProps
>(function RadioField({ label, description, className, id, ...props }, ref) {
  const generatedId = React.useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;

  return (
    <div className={cn('flex min-h-11 items-start gap-3 py-2.5', className)}>
      <RadioGroupItem
        ref={ref}
        id={controlId}
        aria-describedby={descriptionId}
        className="mt-0.5"
        {...props}
      />
      <div className="flex flex-col gap-0.5">
        <label
          htmlFor={controlId}
          className="cursor-pointer text-sm font-medium leading-snug text-foreground"
        >
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
});
