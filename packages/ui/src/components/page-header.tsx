'use client';

import * as React from 'react';
import { cn } from '../lib/cn';

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  /** German page title. Rendered as the page's single `h1`. */
  title: React.ReactNode;
  /** One German sentence explaining what this page is for. */
  description?: React.ReactNode;
  /** `Breadcrumb` element, rendered above the title. */
  breadcrumb?: React.ReactNode;
  /** Status badges shown next to the title. */
  meta?: React.ReactNode;
  /** Primary and secondary actions, right-aligned on wide screens. */
  actions?: React.ReactNode;
  /** Tabs or filters that belong to the page, rendered under the header. */
  toolbar?: React.ReactNode;
}

export const PageHeader = React.forwardRef<HTMLElement, PageHeaderProps>(function PageHeader(
  { className, title, description, breadcrumb, meta, actions, toolbar, ...props },
  ref,
) {
  return (
    <header
      ref={ref}
      className={cn('flex flex-col gap-4 border-b border-border pb-5', className)}
      {...props}
    >
      {breadcrumb}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-xl font-semibold leading-tight tracking-tight text-foreground">
              {title}
            </h1>
            {meta}
          </div>
          {description ? (
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">{actions}</div>
        ) : null}
      </div>
      {toolbar}
    </header>
  );
});
