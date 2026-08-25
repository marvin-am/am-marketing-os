'use client';

import * as React from 'react';
import { CONFIDENCE_LABELS_DE, type ConfidenceLabel } from '@am/domain';
import { CircleCheckBig, FlaskConical, TrendingUp } from 'lucide-react';
import { cn } from '../lib/cn';
import { Badge, type BadgeProps, type BadgeTone } from './badge';
import { InfoHint } from './tooltip';

const CONFIDENCE: Record<
  ConfidenceLabel,
  { tone: BadgeTone; icon: React.ComponentType<{ className?: string }>; explanationDe: string }
> = {
  FACT: {
    tone: 'success',
    icon: CircleCheckBig,
    explanationDe:
      'Fakt: durch eine reife Datenbasis mit ausreichender Stichprobe und hoher Attributionsabdeckung belegt.',
  },
  INDICATION: {
    tone: 'info',
    icon: TrendingUp,
    explanationDe:
      'Indikation: die Daten deuten in diese Richtung, Stichprobe oder Abdeckung reichen für einen Fakt aber nicht aus.',
  },
  HYPOTHESIS: {
    tone: 'neutral',
    icon: FlaskConical,
    explanationDe:
      'Hypothese: eine begründete Annahme ohne belastbare Datengrundlage. Sie ist zu testen, nicht zu berichten.',
  },
};

export interface ConfidenceBadgeProps extends Omit<BadgeProps, 'tone' | 'children'> {
  confidence: ConfidenceLabel;
  withHint?: boolean;
}

/**
 * How strongly a claim, learning or recommendation is supported. The AI layer
 * may never upgrade a label on its own — it is computed (spec §4.4).
 */
export const ConfidenceBadge = React.forwardRef<HTMLSpanElement, ConfidenceBadgeProps>(
  function ConfidenceBadge({ confidence, withHint = true, className, size = 'sm', ...props }, ref) {
    const entry = CONFIDENCE[confidence];
    const Icon = entry.icon;

    return (
      <span className="inline-flex items-center gap-1">
        <Badge
          ref={ref}
          tone={entry.tone}
          size={size}
          data-confidence={confidence}
          className={cn(className)}
          {...props}
        >
          <Icon aria-hidden="true" />
          <span>
            <span className="sr-only">Belegstärke: </span>
            {CONFIDENCE_LABELS_DE[confidence]}
          </span>
        </Badge>
        {withHint ? (
          <InfoHint label="Was bedeutet diese Belegstärke?">{entry.explanationDe}</InfoHint>
        ) : null}
      </span>
    );
  },
);

export const CONFIDENCE_EXPLANATIONS_DE: Readonly<Record<ConfidenceLabel, string>> = {
  FACT: CONFIDENCE.FACT.explanationDe,
  INDICATION: CONFIDENCE.INDICATION.explanationDe,
  HYPOTHESIS: CONFIDENCE.HYPOTHESIS.explanationDe,
};
