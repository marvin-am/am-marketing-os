'use client';

import * as React from 'react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '../lib/cn';

export interface SliderProps
  extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  /** German accessible names, one per thumb. */
  thumbLabels?: readonly string[];
  /** Turns a raw value into the text a screen reader announces. */
  formatValue?: (value: number) => string;
}

export const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  SliderProps
>(function Slider(
  { className, thumbLabels, formatValue, value, defaultValue, ...props },
  ref,
) {
  const current = value ?? defaultValue ?? [0];

  return (
    <SliderPrimitive.Root
      ref={ref}
      value={value}
      defaultValue={defaultValue}
      className={cn(
        'relative flex w-full touch-none select-none items-center py-3',
        'data-[orientation=vertical]:h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5">
        <SliderPrimitive.Range className="absolute h-full bg-brand data-[orientation=vertical]:w-full" />
      </SliderPrimitive.Track>
      {current.map((thumbValue, index) => (
        <SliderPrimitive.Thumb
          key={index}
          aria-label={thumbLabels?.[index]}
          aria-valuetext={formatValue ? formatValue(thumbValue) : undefined}
          className={cn(
            'block size-5 rounded-full border-2 border-brand bg-surface shadow-sm',
            'transition-[box-shadow,transform] duration-150',
            'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
});
