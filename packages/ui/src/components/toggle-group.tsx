'use client';

import * as React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import { type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';
import { toggleVariants } from './toggle.variants';

type ToggleGroupContextValue = VariantProps<typeof toggleVariants>;

const ToggleGroupContext = React.createContext<ToggleGroupContextValue>({
  variant: 'outline',
  size: 'md',
});

type ToggleGroupRootProps = React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>;

/**
 * `Root` is a discriminated union (`type: "single" | "multiple"`); spreading a
 * rest object into it collapses the discriminant, so the element type is
 * widened here while the public prop type stays exact for callers.
 */
const ToggleGroupRoot = ToggleGroupPrimitive.Root as React.ElementType;

export type ToggleGroupProps = ToggleGroupRootProps & ToggleGroupContextValue;

export const ToggleGroup = React.forwardRef<HTMLDivElement, ToggleGroupProps>(function ToggleGroup(
  { className, variant = 'outline', size = 'md', children, ...props },
  ref,
) {
  const context = React.useMemo(() => ({ variant, size }), [variant, size]);
  return (
    <ToggleGroupRoot
      ref={ref}
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={context}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupRoot>
  );
});

export const ToggleGroupItem = React.forwardRef<
  React.ComponentRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> & ToggleGroupContextValue
>(function ToggleGroupItem({ className, variant, size, ...props }, ref) {
  const context = React.useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        toggleVariants({
          variant: variant ?? context.variant,
          size: size ?? context.size,
        }),
        className,
      )}
      {...props}
    />
  );
});
