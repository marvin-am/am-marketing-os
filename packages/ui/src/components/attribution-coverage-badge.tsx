'use client';

import * as React from 'react';
import { CircleHelp, Crosshair, ScanSearch, TriangleAlert } from 'lucide-react';
import { cn } from '../lib/cn';
import { formatPercentDe, NO_VALUE } from '../lib/format';
import { Badge, type BadgeProps, type BadgeTone } from './badge';
import { InfoHint } from './tooltip';

/** Coverage at or above this share counts as trustworthy for reporting. */
export const COVERAGE_TRUSTWORTHY = 0.8;
/** Below this share a revenue claim must not be presented without a warning. */
export const COVERAGE_WEAK = 0.5;

const EXPLANATION_DE =
  'Attributionsabdeckung: Anteil der zugrunde liegenden Datensätze mit exakter oder hoch-konfidenter Zuordnung. Bei geringer Abdeckung beruht die Kennzahl überwiegend auf unsicheren Zuordnungen und darf nicht als gemessener Fakt gelesen werden.';

interface CoverageAppearance {
  tone: BadgeTone;
  icon: React.ComponentType<{ className?: string }>;
  qualifierDe: string;
}

export function coverageAppearance(coverage: number | null): CoverageAppearance {
  if (coverage === null) {
    return { tone: 'neutral', icon: CircleHelp, qualifierDe: 'keine Zuordnungsdaten' };
  }
  if (coverage >= COVERAGE_TRUSTWORTHY) {
    return { tone: 'success', icon: Crosshair, qualifierDe: 'belastbar' };
  }
  if (coverage >= COVERAGE_WEAK) {
    return { tone: 'warning', icon: ScanSearch, qualifierDe: 'eingeschränkt belastbar' };
  }
  return { tone: 'destructive', icon: TriangleAlert, qualifierDe: 'nicht belastbar' };
}

export interface AttributionCoverageBadgeProps extends Omit<BadgeProps, 'tone' | 'children'> {
  /** Share between 0 and 1, or `null` when nothing could be attributed at all. */
  coverage: number | null;
  withHint?: boolean;
}

/**
 * Renders the share of records behind a metric that carry EXACT or
 * HIGH_CONFIDENCE attribution, so a 4× ROAS built on weak matches can never be
 * mistaken for a measurement (spec §21).
 */
export const AttributionCoverageBadge = React.forwardRef<
  HTMLSpanElement,
  AttributionCoverageBadgeProps
>(function AttributionCoverageBadge(
  { coverage, withHint = true, className, size = 'sm', ...props },
  ref,
) {
  const appearance = coverageAppearance(coverage);
  const Icon = appearance.icon;
  const display = coverage === null ? NO_VALUE : formatPercentDe(coverage, 0);

  return (
    <span className="inline-flex items-center gap-1">
      <Badge
        ref={ref}
        tone={appearance.tone}
        size={size}
        data-coverage={coverage === null ? 'unknown' : coverage.toFixed(4)}
        className={cn(className)}
        {...props}
      >
        <Icon aria-hidden="true" />
        <span>
          <span className="sr-only">Attributionsabdeckung: </span>
          {display}
          <span className="sr-only"> – {appearance.qualifierDe}</span>
        </span>
      </Badge>
      {withHint ? (
        <InfoHint label="Was bedeutet die Attributionsabdeckung?">{EXPLANATION_DE}</InfoHint>
      ) : null}
    </span>
  );
});

export { EXPLANATION_DE as ATTRIBUTION_COVERAGE_EXPLANATION_DE };
