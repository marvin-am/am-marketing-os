'use client';

import * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import { cn } from '../lib/cn';

/**
 * Bottom drawer for touch. Use it where a `Sheet` would be uncomfortable on a
 * phone — the funnel builder inspector, filter stacks, mobile detail views.
 *
 * The explicit type annotations below are required: `vaul` re-exports types
 * from its own copy of `@radix-ui/react-dialog`, which this package does not
 * depend on directly, so the inferred types would not be portable.
 */
export function Drawer({
  shouldScaleBackground = true,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root shouldScaleBackground={shouldScaleBackground} {...props} />;
}

export const DrawerTrigger: typeof DrawerPrimitive.Trigger = DrawerPrimitive.Trigger;
export const DrawerPortal: typeof DrawerPrimitive.Portal = DrawerPrimitive.Portal;
export const DrawerClose: typeof DrawerPrimitive.Close = DrawerPrimitive.Close;

export type DrawerOverlayProps = React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Overlay>;

export const DrawerOverlay: React.ForwardRefExoticComponent<
  DrawerOverlayProps & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<HTMLDivElement, DrawerOverlayProps>(function DrawerOverlay(
  { className, ...props },
  ref,
) {
  return (
    <DrawerPrimitive.Overlay
      ref={ref}
      className={cn('fixed inset-0 z-50 bg-overlay', className)}
      {...props}
    />
  );
});

export interface DrawerContentProps
  extends React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Content> {
  /** Screen-reader text for the drag handle. */
  handleLabel?: string;
}

export const DrawerContent: React.ForwardRefExoticComponent<
  DrawerContentProps & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<HTMLDivElement, DrawerContentProps>(function DrawerContent(
  { className, children, handleLabel = 'Ziehgriff – nach unten ziehen zum Schließen', ...props },
  ref,
) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        ref={ref}
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 mt-24 flex max-h-[92dvh] flex-col',
          'rounded-t-2xl border border-b-0 border-border bg-surface shadow-xl focus:outline-none',
          className,
        )}
        {...props}
      >
        <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-border-strong">
          <span className="sr-only">{handleLabel}</span>
        </div>
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
});

export function DrawerHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 px-5 pb-3 pt-4', className)} {...props} />;
}

export function DrawerBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-3', className)} {...props} />;
}

export function DrawerFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-2 border-t border-border px-5 py-4', className)}
      {...props}
    />
  );
}

export type DrawerTitleProps = React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Title>;

export const DrawerTitle: React.ForwardRefExoticComponent<
  DrawerTitleProps & React.RefAttributes<HTMLHeadingElement>
> = React.forwardRef<HTMLHeadingElement, DrawerTitleProps>(function DrawerTitle(
  { className, ...props },
  ref,
) {
  return (
    <DrawerPrimitive.Title
      ref={ref}
      className={cn('text-base font-semibold leading-tight tracking-tight', className)}
      {...props}
    />
  );
});

export type DrawerDescriptionProps = React.ComponentPropsWithoutRef<
  typeof DrawerPrimitive.Description
>;

export const DrawerDescription: React.ForwardRefExoticComponent<
  DrawerDescriptionProps & React.RefAttributes<HTMLParagraphElement>
> = React.forwardRef<HTMLParagraphElement, DrawerDescriptionProps>(function DrawerDescription(
  { className, ...props },
  ref,
) {
  return (
    <DrawerPrimitive.Description
      ref={ref}
      className={cn('text-sm leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
});
