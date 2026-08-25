import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

/*
 * Server-safe: this module is deliberately not marked 'use client'.
 * A cva() call is a pure function, and a server component must be able
 * to reuse these classes on a native element without pulling the
 * component's client bundle in.
 */

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

export type InputVariantsProps = VariantProps<typeof inputVariants>;
