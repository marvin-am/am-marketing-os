import type { ProgressState } from '@am/funnel-schema';
import type { ThemeSpec } from '@am/funnel-schema';

/**
 * Progress that never lies.
 *
 * `computeProgress` only reports a total when every possible continuation from
 * the current step has the same length. The moment a disqualifying answer can
 * end the form early — which is true of every qualification funnel we build —
 * the mode is `indeterminate`, and this component renders "Schritt 3" with no
 * percentage rather than a fabricated "43 %".
 *
 * That is not a cosmetic choice. A progress bar that jumps from 43 % to done,
 * or crawls because the visitor took the long branch, is a measurable
 * abandonment driver, and it is dishonest in the plain sense: the number was
 * never knowable.
 *
 * ARIA follows the same rule. An indeterminate `progressbar` deliberately
 * carries no `aria-valuenow`, which is how the specification says "unknown"; a
 * placeholder value would announce the same lie to a screen reader.
 */

export interface StepProgressProps {
  progress: ProgressState;
  style: ThemeSpec['progressStyle'];
}

export function StepProgress({ progress, style }: StepProgressProps) {
  if (style === 'NONE') return null;

  const exact = progress.mode === 'exact' && progress.knownTotal !== null;
  const total = progress.knownTotal ?? 0;
  const percent = exact && total > 0 ? Math.round((progress.stepIndex / total) * 100) : null;

  const label = exact
    ? `Schritt ${progress.stepIndex} von ${total}`
    : `Schritt ${progress.stepIndex}`;

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {percent !== null ? (
          <p className="text-sm tabular-nums text-muted-foreground">{percent} %</p>
        ) : (
          <p className="text-sm text-muted-foreground">Noch wenige Fragen</p>
        )}
      </div>

      {style === 'DOTS' ? (
        <div
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={exact ? total : undefined}
          aria-valuenow={exact ? progress.stepIndex : undefined}
          aria-valuetext={label}
          aria-label="Fortschritt im Formular"
          className="flex min-w-0 flex-wrap gap-1.5"
        >
          {Array.from({ length: exact ? total : progress.stepIndex }, (_, index) => (
            <span
              key={index}
              className={
                index < progress.stepIndex
                  ? 'h-2 w-2 rounded-full bg-brand'
                  : 'h-2 w-2 rounded-full bg-border'
              }
            />
          ))}
        </div>
      ) : (
        <div
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={exact ? total : undefined}
          aria-valuenow={exact ? progress.stepIndex : undefined}
          aria-valuetext={label}
          aria-label="Fortschritt im Formular"
          className="h-1.5 w-full overflow-hidden rounded-full bg-border"
        >
          <span
            className="block h-full rounded-full bg-brand"
            /* An unknown remainder gets a fixed, small lead-in rather than a
               width that pretends to be a fraction of a total we do not have. */
            style={{ width: percent !== null ? `${percent}%` : '12%' }}
          />
        </div>
      )}
    </div>
  );
}
