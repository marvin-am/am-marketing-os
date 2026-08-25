'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

export const inputVariants = cva(
  cn(
    'flex w-full rounded-md border bg-surface text-sm text-foreground shadow-xs',
    'placeholder:text-muted-foreground',
    'transition-[border-color,box-shadow] duration-150',
    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70',
    'file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
    'aria-[invalid=true]:border-destructive aria-[invalid=true]:outline-destructive',
  ),
  {
    variants: {
      inputSize: {
        sm: 'h-9 px-2.5',
        md: 'h-11 px-3',
        lg: 'h-12 px-3.5 text-base',
      },
      tone: {
        default: 'border-input',
        invalid: 'border-destructive',
      },
    },
    defaultVariants: {
      inputSize: 'md',
      tone: 'default',
    },
  },
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, inputSize, tone, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(inputVariants({ inputSize, tone }), className)}
      {...props}
    />
  );
});
