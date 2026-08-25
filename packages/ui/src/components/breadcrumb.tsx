'use client';

import * as React from 'react';
import { Slot } from 'radix-ui';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { cn } from '../lib/cn';

export const Breadcrumb = React.forwardRef<
  HTMLElement,
  React.ComponentPropsWithoutRef<'nav'> & { label?: string }
>(function Breadcrumb({ className, label = 'Brotkrumen-Navigation', ...props }, ref) {
  return <nav ref={ref} aria-label={label} className={cn('w-full', className)} {...props} />;
});

export const BreadcrumbList = React.forwardRef<
  HTMLOListElement,
  React.ComponentPropsWithoutRef<'ol'>
>(function BreadcrumbList({ className, ...props }, ref) {
  return (
    <ol
      ref={ref}
      className={cn(
        'flex flex-wrap items-center gap-1.5 break-words text-sm text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
});

export const BreadcrumbItem = React.forwardRef<HTMLLIElement, React.ComponentPropsWithoutRef<'li'>>(
  function BreadcrumbItem({ className, ...props }, ref) {
    return <li ref={ref} className={cn('inline-flex items-center gap-1.5', className)} {...props} />;
  },
);

export const BreadcrumbLink = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentPropsWithoutRef<'a'> & { asChild?: boolean }
>(function BreadcrumbLink({ className, asChild = false, ...props }, ref) {
  const Comp = (asChild ? Slot.Root : 'a') as React.ElementType;
  return (
    <Comp
      ref={ref}
      className={cn(
        'inline-flex min-h-11 items-center rounded-sm transition-colors hover:text-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
      {...props}
    />
  );
});

export const BreadcrumbPage = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<'span'>
>(function BreadcrumbPage({ className, ...props }, ref) {
  return (
    <span
      ref={ref}
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn('inline-flex min-h-11 items-center font-medium text-foreground', className)}
      {...props}
    />
  );
});

export function BreadcrumbSeparator({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'li'>) {
  return (
    <li role="presentation" aria-hidden="true" className={cn('[&>svg]:size-3.5', className)} {...props}>
      {children ?? <ChevronRight />}
    </li>
  );
}

export function BreadcrumbEllipsis({ className, ...props }: React.ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      role="presentation"
      aria-hidden="true"
      className={cn('flex size-9 items-center justify-center', className)}
      {...props}
    >
      <MoreHorizontal className="size-4" />
      <span className="sr-only">Weitere Ebenen</span>
    </span>
  );
}
