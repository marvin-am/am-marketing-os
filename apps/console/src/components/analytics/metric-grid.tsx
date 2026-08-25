import * as React from 'react';
import { METRIC_CATALOG, type MetricKey } from '@am/domain';
import { MetricTile, metricBasisDe, noDenominatorNoteDe } from '@am/ui';
import type { MetricSnapshot } from '@/server/analytics-port';

export interface MetricGridProps {
  snapshot: MetricSnapshot;
  /** Catalogue metrics to show, in the order the funnel runs. */
  keys: readonly MetricKey[];
  columns?: 2 | 3 | 4;
}

const COLUMN_CLASSES: Record<2 | 3 | 4, string> = {
  2: 'grid gap-3 sm:grid-cols-2',
  3: 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4',
};

/**
 * A row of metric tiles built from one snapshot.
 *
 * Every tile carries its basis, its data maturity and — for the CRM-delayed
 * metrics — the attribution coverage the number rests on. That combination is
 * the point: a 4× ROAS beside "Unreif" and "38 %" cannot be read as a measured
 * fact, which is exactly what it is not.
 */
export function MetricGrid({ snapshot, keys, columns = 4 }: MetricGridProps): React.JSX.Element {
  return (
    <div className={COLUMN_CLASSES[columns]}>
      {keys.map((key) => {
        const value = snapshot.metrics[key];
        const note = noDenominatorNoteDe(value);
        return (
          <MetricTile
            key={key}
            value={value}
            denominatorLabel={metricBasisDe(value)}
            hint={`Berechnung: ${METRIC_CATALOG[key].formula}`}
            footer={note}
          />
        );
      })}
    </div>
  );
}
