'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

export const cardVariants = cva(
  'rounded-lg border border-border bg-surface text-foreground',
  {
    variants: {
      elevation: {
        flat: '',
        raised: 'shadow-sm',
        floating: 'shadow-md',
      },
      tone: {
        default: '',
        muted: 'bg-surface-raised',
        destructive: 'border-destructive-border bg-destructive-surface',
        warning: 'border-warning-border bg-warning-surface',
      },
    },
    defaultVariants: {
      elevation: 'flat',
      tone: 'default',
    },
  },
);

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, elevation, tone, ...props },
  ref,
) {
  return <div ref={ref} className={cn(cardVariants({ elevation, tone }), className)} {...props} />;
});

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('flex flex-col gap-1.5 px-5 pb-3 pt-5', className)}
        {...props}
      />
    );
  },
);

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement> & { as?: 'h2' | 'h3' | 'h4' }
>(function CardTitle({ className, as: Comp = 'h3', ...props }, ref) {
  return (
    <Comp
      ref={ref}
      className={cn('text-base font-semibold leading-tight tracking-tight', className)}
      {...props}
    />
  );
});

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />;
});

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn('px-5 py-4', className)} {...props} />;
  },
);

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-wrap items-center gap-2 border-t border-border px-5 py-3.5',
          className,
        )}
        {...props}
      />
    );
  },
);
