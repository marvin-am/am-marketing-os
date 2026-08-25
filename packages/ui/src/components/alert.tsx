'use client';

import * as React from 'react';
import { type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import { cn } from '../lib/cn';
import { alertVariants } from './alert.variants';

export type AlertTone = NonNullable<VariantProps<typeof alertVariants>['tone']>;

const DEFAULT_ICON: Record<AlertTone, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: OctagonAlert,
  neutral: Info,
};

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  /** Pass `null` to suppress the icon; otherwise a tone-appropriate one is used. */
  icon?: React.ReactNode | null;
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { className, tone = 'neutral', icon, children, ...props },
  ref,
) {
  const Fallback = DEFAULT_ICON[tone ?? 'neutral'];
  return (
    <div
      ref={ref}
      role={tone === 'destructive' ? 'alert' : 'status'}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      {icon === null ? null : (icon ?? <Fallback aria-hidden="true" />)}
      <div className="col-start-2 flex flex-col gap-1">{children}</div>
    </div>
  );
});

export const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function AlertTitle({ className, ...props }, ref) {
  return (
    <p ref={ref} className={cn('font-semibold leading-tight tracking-tight', className)} {...props} />
  );
});

export const AlertDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function AlertDescription({ className, ...props }, ref) {
  return <div ref={ref} className={cn('text-sm leading-relaxed opacity-90', className)} {...props} />;
});
