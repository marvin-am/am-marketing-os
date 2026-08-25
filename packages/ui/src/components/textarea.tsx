'use client';

import * as React from 'react';
import { cn } from '../lib/cn';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grows the field to fit its content instead of scrolling. */
  autoResize?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autoResize = false, onChange, rows = 4, ...props },
  ref,
) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

  const resize = React.useCallback(() => {
    const node = innerRef.current;
    if (!node || !autoResize) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [autoResize]);

  React.useEffect(() => {
    resize();
  }, [resize, props.value]);

  return (
    <textarea
      ref={(node) => {
        innerRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      rows={rows}
      onChange={(event) => {
        resize();
        onChange?.(event);
      }}
      className={cn(
        'flex w-full rounded-md border border-input bg-surface px-3 py-2.5 text-sm text-foreground shadow-xs',
        'placeholder:text-muted-foreground',
        'transition-[border-color,box-shadow] duration-150',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:outline-destructive',
        autoResize ? 'resize-none overflow-hidden' : 'resize-y',
        className,
      )}
      {...props}
    />
  );
});
