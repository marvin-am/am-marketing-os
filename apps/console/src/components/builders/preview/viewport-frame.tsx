'use client';

import * as React from 'react';
import { Eye, Monitor, Smartphone } from 'lucide-react';
import { cn, Badge, Button } from '@am/ui';
import { PREVIEW_MARKER_DE } from '../labels';

/**
 * The constrained frame every preview is rendered inside.
 *
 * Two jobs. First, the viewport switcher: 320 px is the narrowest phone still in
 * real use and the width where a funnel actually breaks, so it is the first
 * option rather than an afterthought. The frame carries the chosen width as an
 * inline style and clips horizontal overflow, which is what makes "does this fit
 * at 320 px?" answerable inside the console instead of on a device.
 *
 * Second, the marker. A preview that looks like the published funnel is a
 * liability, so `Vorschau — nicht die veröffentlichte Strecke` sits inside the
 * frame, above the content, in every viewport and at every moment.
 */

export interface PreviewViewport {
  id: string;
  labelDe: string;
  /** `null` renders the desktop width, i.e. as wide as the pane allows. */
  width: number | null;
}

export const PREVIEW_VIEWPORTS: readonly PreviewViewport[] = [
  { id: '320', labelDe: '320 px', width: 320 },
  { id: '375', labelDe: '375 px', width: 375 },
  { id: '430', labelDe: '430 px', width: 430 },
  { id: 'desktop', labelDe: 'Desktop', width: null },
];

export interface ViewportFrameProps {
  children: React.ReactNode;
  /** German note under the marker, e.g. the version state. */
  noteDe?: string;
  initialViewportId?: string;
  toolbarExtra?: React.ReactNode;
  className?: string;
}

export function ViewportFrame({
  children,
  noteDe,
  initialViewportId = '375',
  toolbarExtra,
  className,
}: ViewportFrameProps) {
  const [viewportId, setViewportId] = React.useState(initialViewportId);
  const viewport =
    PREVIEW_VIEWPORTS.find((entry) => entry.id === viewportId) ?? PREVIEW_VIEWPORTS[1];

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Vorschaubreite">
          {PREVIEW_VIEWPORTS.map((entry) => {
            const active = entry.id === viewport?.id;
            return (
              <Button
                key={entry.id}
                type="button"
                size="sm"
                variant={active ? 'secondary' : 'ghost'}
                aria-pressed={active}
                onClick={() => setViewportId(entry.id)}
              >
                {entry.width === null ? (
                  <Monitor aria-hidden="true" />
                ) : (
                  <Smartphone aria-hidden="true" />
                )}
                {entry.labelDe}
              </Button>
            );
          })}
        </div>
        {toolbarExtra}
      </div>

      <div className="flex justify-center overflow-x-auto rounded-lg bg-surface-sunken p-3">
        <div
          data-testid="preview-frame"
          data-viewport={viewport?.id}
          style={{
            width: viewport?.width === null ? '100%' : `${viewport?.width}px`,
            maxWidth: '100%',
            overflowX: 'hidden',
          }}
          className="flex flex-col rounded-lg border border-border bg-surface shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-warning-surface px-3 py-2">
            <Badge tone="warning" size="sm">
              <Eye aria-hidden="true" />
              Vorschau
            </Badge>
            <span className="text-xs font-medium text-warning">{PREVIEW_MARKER_DE}</span>
            {noteDe ? <span className="text-xs text-muted-foreground">{noteDe}</span> : null}
          </div>
          <div className="min-w-0 break-words p-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
