'use client';

import * as React from 'react';
import { Slot } from 'radix-ui';
import { cn } from '../lib/cn';
import { Badge } from './badge';

export interface SidebarNavProps extends React.ComponentPropsWithoutRef<'nav'> {
  /** German accessible name, e.g. "Hauptnavigation". Required. */
  label: string;
}

/**
 * The console's primary navigation. Compositional on purpose: the app supplies
 * its own link component (`next/link`) through `asChild`, so this package
 * stays framework-agnostic.
 */
export const SidebarNav = React.forwardRef<HTMLElement, SidebarNavProps>(function SidebarNav(
  { className, label, children, ...props },
  ref,
) {
  return (
    <nav
      ref={ref}
      aria-label={label}
      className={cn('flex w-full flex-col gap-6 py-2', className)}
      {...props}
    >
      {children}
    </nav>
  );
});

export interface SidebarNavGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** German group heading, e.g. "Kampagnen". */
  label?: string;
}

export const SidebarNavGroup = React.forwardRef<HTMLDivElement, SidebarNavGroupProps>(
  function SidebarNavGroup({ className, label, children, ...props }, ref) {
    const headingId = React.useId();
    return (
      <div
        ref={ref}
        role="group"
        aria-labelledby={label ? headingId : undefined}
        className={cn('flex flex-col gap-1', className)}
        {...props}
      >
        {label ? (
          <p
            id={headingId}
            className="px-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {label}
          </p>
        ) : null}
        <ul className="flex flex-col gap-0.5">{children}</ul>
      </div>
    );
  },
);

export interface SidebarNavItemProps extends React.ComponentPropsWithoutRef<'a'> {
  /** Marks the current page: sets `aria-current="page"` and the active style. */
  active?: boolean;
  /**
   * Render the child element (e.g. `next/link`) instead of an `<a>`.
   *
   * The child must be a single element wrapping a single label — the icon and
   * the badge are injected around it, so
   * `<SidebarNavItem asChild icon={…} badge={3}><Link href="…">Kampagnen</Link></SidebarNavItem>`
   * is the supported shape.
   */
  asChild?: boolean;
  icon?: React.ReactNode;
  /** Count or state shown at the end of the row. */
  badge?: React.ReactNode;
  disabled?: boolean;
}

export const SidebarNavItem = React.forwardRef<HTMLAnchorElement, SidebarNavItemProps>(
  function SidebarNavItem(
    { className, active = false, asChild = false, icon, badge, disabled = false, children, ...props },
    ref,
  ) {
    const Comp = (asChild ? Slot.Root : 'a') as React.ElementType;
    const badgeNode =
      badge === undefined || badge === null ? null : typeof badge === 'string' ||
        typeof badge === 'number' ? (
        <Badge tone="neutral" size="sm">
          {badge}
        </Badge>
      ) : (
        badge
      );

    return (
      <li>
        <Comp
          ref={ref}
          aria-current={active ? 'page' : undefined}
          aria-disabled={disabled || undefined}
          data-active={active ? '' : undefined}
          className={cn(
            'group relative flex min-h-11 min-w-0 items-center gap-2.5 overflow-hidden rounded-md px-3 text-sm',
            'transition-colors duration-150',
            // Inset: the row is `overflow-hidden` for the active rail, which
            // would clip an outset ring.
            'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
            'text-muted-foreground hover:bg-surface-sunken hover:text-foreground',
            // Active rows get a brand rail plus a weight change, so the current
            // page is not signalled by colour alone.
            "data-[active]:bg-surface-sunken data-[active]:font-semibold data-[active]:text-foreground",
            "data-[active]:before:absolute data-[active]:before:left-0 data-[active]:before:top-1/2 data-[active]:before:h-5 data-[active]:before:w-0.5",
            "data-[active]:before:-translate-y-1/2 data-[active]:before:rounded-full data-[active]:before:bg-brand data-[active]:before:content-['']",
            'aria-disabled:pointer-events-none aria-disabled:opacity-50',
            '[&_svg]:size-4 [&_svg]:shrink-0',
            className,
          )}
          {...props}
        >
          {icon}
          {/*
           * `Slot` renders exactly one element and would throw on the
           * icon/label/badge trio; `Slot.Slottable` marks the label as the
           * element to render and re-parents the siblings into it. Outside
           * `asChild` the label keeps its own truncating box.
           */}
          {asChild ? (
            <Slot.Slottable>{children}</Slot.Slottable>
          ) : (
            <span className="min-w-0 flex-1 truncate">{children}</span>
          )}
          {badgeNode ? <span className="ml-auto shrink-0">{badgeNode}</span> : null}
        </Comp>
      </li>
    );
  },
);
