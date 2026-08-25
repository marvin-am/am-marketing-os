'use client';

import * as React from 'react';
import { DATA_MATURITY_LABELS_DE, type DataMaturity } from '@am/domain';
import { CircleDashed, CircleDot, CircleCheckBig } from 'lucide-react';
import { cn } from '../lib/cn';
import { Badge, type BadgeProps, type BadgeTone } from './badge';
import { InfoHint } from './tooltip';

const MATURITY: Record<
  DataMaturity,
  { tone: BadgeTone; icon: React.ComponentType<{ className?: string }>; explanationDe: string }
> = {
  IMMATURE: {
    tone: 'warning',
    icon: CircleDashed,
    explanationDe:
      'Unreif: Laufzeit oder Stichprobe reichen noch nicht aus. Die Zahl ist eine Momentaufnahme und trägt keine Budgetentscheidung.',
  },
  PARTIAL: {
    tone: 'info',
    icon: CircleDot,
    explanationDe:
      'Teilweise reif: Eine Tendenz ist erkennbar, die Datenbasis ist für eine endgültige Bewertung aber noch zu schmal.',
  },
  MATURE: {
    tone: 'success',
    icon: CircleCheckBig,
    explanationDe:
      'Reif: Laufzeit und Stichprobe erfüllen die hinterlegten Schwellen. Die Kennzahl ist belastbar.',
  },
};

export interface DataMaturityBadgeProps extends Omit<BadgeProps, 'tone' | 'children'> {
  maturity: DataMaturity;
  /** Show the "?" affordance with the German explanation. Default: true. */
  withHint?: boolean;
}

/**
 * Data maturity for one metric. Every number in the console is shown with this
 * badge so a figure can never be read without its reliability context
 * (spec §4.3).
 */
export const DataMaturityBadge = React.forwardRef<HTMLSpanElement, DataMaturityBadgeProps>(
  function DataMaturityBadge({ maturity, withHint = true, className, size = 'sm', ...props }, ref) {
    const entry = MATURITY[maturity];
    const Icon = entry.icon;

    return (
      <span className="inline-flex items-center gap-1">
        <Badge
          ref={ref}
          tone={entry.tone}
          size={size}
          data-maturity={maturity}
          className={cn(className)}
          {...props}
        >
          <Icon aria-hidden="true" />
          <span>
            <span className="sr-only">Datenreife: </span>
            {DATA_MATURITY_LABELS_DE[maturity]}
          </span>
        </Badge>
        {withHint ? (
          <InfoHint label="Was bedeutet die Datenreife?">{entry.explanationDe}</InfoHint>
        ) : null}
      </span>
    );
  },
);

export const DATA_MATURITY_EXPLANATIONS_DE: Readonly<Record<DataMaturity, string>> = {
  IMMATURE: MATURITY.IMMATURE.explanationDe,
  PARTIAL: MATURITY.PARTIAL.explanationDe,
  MATURE: MATURITY.MATURE.explanationDe,
};
