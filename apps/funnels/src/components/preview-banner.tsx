import { Eye } from 'lucide-react';
import { FUNNEL_VERSION_STATE_LABELS_DE } from '@am/ui/lib/status';
import type { FunnelVersionState } from '@am/domain';

/**
 * The preview marker.
 *
 * A preview render must be impossible to mistake for the live page — both by a
 * person looking at it and by the metrics. The banner covers the first; the
 * `am_preview` cookie set in `middleware.ts` covers the second, which is what
 * makes `classifyTraffic` return `PREVIEW` and keeps every event this render
 * produces out of production rollups and experiment results.
 *
 * It also states plainly which version is on screen. A draft that looks like the
 * published page is how a reviewer approves something that was never shipped.
 */

export interface PreviewBannerProps {
  funnelVersionId: string;
  state: FunnelVersionState;
  publishedAt: string | null;
}

export function PreviewBanner({ funnelVersionId, state, publishedAt }: PreviewBannerProps) {
  return (
    <div
      role="status"
      className="w-full min-w-0 border-b border-warning-border bg-warning-surface px-4 py-3"
    >
      <div className="mx-auto flex w-full max-w-2xl min-w-0 items-start gap-2">
        <Eye className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <div className="grid min-w-0 gap-1 text-sm">
          <p className="font-semibold text-foreground">
            Vorschau — keine produktive Seite. Diese Ansicht zählt nicht in Metriken oder
            Experimenten.
          </p>
          <p className="break-words text-muted-foreground">
            Status: {FUNNEL_VERSION_STATE_LABELS_DE[state]} · Version {funnelVersionId}
            {publishedAt ? ` · veröffentlicht am ${publishedAt.slice(0, 10)}` : ' · nicht veröffentlicht'}
          </p>
        </div>
      </div>
    </div>
  );
}
