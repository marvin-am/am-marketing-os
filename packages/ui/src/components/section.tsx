'use client';

import * as React from 'react';
import { cn } from '../lib/cn';

export interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  /** German section heading. Omit for an unlabelled grouping. */
  heading?: React.ReactNode;
  /** Heading level. The page title is the `h1`, so sections start at `h2`. */
  headingLevel?: 2 | 3 | 4;
  description?: React.ReactNode;
  /** Buttons or filters belonging to this section. */
  actions?: React.ReactNode;
  /** Badges rendered next to the heading. */
  meta?: React.ReactNode;
  /** Wrap the content in a bordered surface. */
  bordered?: boolean;
  contentClassName?: string;
}

export const Section = React.forwardRef<HTMLElement, SectionProps>(function Section(
  {
    className,
    contentClassName,
    heading,
    headingLevel = 2,
    description,
    actions,
    meta,
    bordered = false,
    children,
    ...props
  },
  ref,
) {
  const headingId = React.useId();
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';

  return (
    <section
      ref={ref}
      aria-labelledby={heading ? headingId : undefined}
      className={cn('flex flex-col gap-4', className)}
      {...props}
    >
      {heading || actions || description ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            {heading ? (
              <div className="flex flex-wrap items-center gap-2">
                <Heading
                  id={headingId}
                  className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {heading}
                </Heading>
                {meta}
              </div>
            ) : null}
            {description ? (
              <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}
      <div
        className={cn(
          bordered && 'rounded-lg border border-border bg-surface p-4',
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
});
