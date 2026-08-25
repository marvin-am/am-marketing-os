'use client';

import * as React from 'react';
import { cn } from '../lib/cn';

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  /** German caption. Required for a data table with more than one column. */
  caption?: React.ReactNode;
  /** Renders the caption visually while keeping it available to AT when false. */
  captionVisible?: boolean;
  containerClassName?: string;
}

export const Table = React.forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, containerClassName, caption, captionVisible = false, children, ...props },
  ref,
) {
  return (
    <div className={cn('w-full overflow-x-auto', containerClassName)}>
      <table
        ref={ref}
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      >
        {caption ? (
          <caption
            className={cn(
              'text-left text-xs text-muted-foreground',
              captionVisible ? 'pb-3' : 'sr-only',
            )}
          >
            {caption}
          </caption>
        ) : null}
        {children}
      </table>
    </div>
  );
});

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return <thead ref={ref} className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} />;
});

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
});

export const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableFooter({ className, ...props }, ref) {
  return (
    <tfoot
      ref={ref}
      className={cn('border-t border-border bg-surface-raised font-medium', className)}
      {...props}
    />
  );
});

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(function TableRow({ className, ...props }, ref) {
  return (
    <tr
      ref={ref}
      className={cn(
        'border-b border-border transition-colors',
        'hover:bg-surface-raised data-[state=selected]:bg-brand-subtle',
        className,
      )}
      {...props}
    />
  );
});

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }
>(function TableHead({ className, numeric = false, scope = 'col', ...props }, ref) {
  return (
    <th
      ref={ref}
      scope={scope}
      className={cn(
        'h-11 px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground',
        numeric && 'text-right',
        className,
      )}
      {...props}
    />
  );
});

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }
>(function TableCell({ className, numeric = false, ...props }, ref) {
  return (
    <td
      ref={ref}
      data-am-numeric={numeric ? '' : undefined}
      className={cn('px-3 py-3 align-middle', numeric && 'text-right', className)}
      {...props}
    />
  );
});

export const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(function TableCaption({ className, ...props }, ref) {
  return <caption ref={ref} className={cn('mt-3 text-xs text-muted-foreground', className)} {...props} />;
});
