import * as React from 'react';
import Link from 'next/link';
import { EXPERIMENT_KIND_LABELS_DE, METRIC_CATALOG } from '@am/domain';
import {
  Badge,
  DataMaturityBadge,
  EmptyState,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@am/ui';
import { formatDate, formatDuration, formatNumber } from '@/lib/format';
import type { ExperimentSummary } from '@/server/analytics-port';
import { ExperimentVerdictBadge } from './experiment-verdict';
import { InterpretationWarnings } from './interpretation-warnings';

export interface ExperimentListProps {
  experiments: readonly ExperimentSummary[];
}

/**
 * Every experiment with its kind, state, runtime, arms and verdict.
 *
 * The verdict never stands alone: the interpretation warnings ride along in the
 * same row, so a bundled test or a Meta-optimised exploration is flagged before
 * anybody clicks into it.
 */
export function ExperimentList({ experiments }: ExperimentListProps): React.JSX.Element {
  if (experiments.length === 0) {
    return (
      <EmptyState
        title="Noch keine Experimente"
        description="Sobald ein Test geplant und gestartet wurde, erscheint er hier mit Laufzeit, Armen und Urteil."
      />
    );
  }

  return (
    <Table caption="Experimente mit Art, Status, Laufzeit, Armen und Urteil">
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="min-w-64">
            Experiment
          </TableHead>
          <TableHead scope="col">Art</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Laufzeit</TableHead>
          <TableHead scope="col" className="text-right">
            Arme
          </TableHead>
          <TableHead scope="col">Primärmetrik</TableHead>
          <TableHead scope="col">Urteil</TableHead>
          <TableHead scope="col" className="min-w-56">
            Hinweise zur Interpretierbarkeit
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {experiments.map((entry) => {
          const result = entry.evaluation.result;
          return (
            <TableRow key={entry.experiment.id} data-experiment-id={entry.experiment.id}>
              <TableCell className="align-top">
                <span className="flex flex-col gap-1 leading-tight">
                  <Link
                    href={`/experimente/${entry.experiment.id}`}
                    className="font-medium text-foreground underline underline-offset-2 hover:text-brand"
                  >
                    {entry.experiment.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">{entry.campaignLabelDe}</span>
                  <span className="text-xs text-muted-foreground">
                    Testvariable: {entry.experiment.test_variable}
                  </span>
                </span>
              </TableCell>
              <TableCell className="align-top">
                <Badge tone="outline" size="sm">
                  {EXPERIMENT_KIND_LABELS_DE[entry.experiment.kind]}
                </Badge>
              </TableCell>
              <TableCell className="align-top">
                <StatusBadge kind="experiment" state={entry.experiment.state} />
              </TableCell>
              <TableCell className="align-top">
                <span className="flex flex-col leading-tight">
                  <span data-am-numeric="" className="text-foreground">
                    {formatDuration(result.runtimeDays)}
                  </span>
                  <span data-am-numeric="" className="text-xs text-muted-foreground">
                    ab {formatDate(entry.experiment.started_at)}
                    {entry.experiment.concluded_at
                      ? ` bis ${formatDate(entry.experiment.concluded_at)}`
                      : ''}
                  </span>
                </span>
              </TableCell>
              <TableCell data-am-numeric="" className="align-top text-right">
                {formatNumber(entry.arms.length)}
              </TableCell>
              <TableCell className="align-top">
                <span className="flex flex-col leading-tight">
                  <span className="text-foreground">
                    {METRIC_CATALOG[entry.experiment.primary_metric].label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {METRIC_CATALOG[entry.experiment.primary_metric].formula}
                  </span>
                </span>
              </TableCell>
              <TableCell className="align-top">
                <span className="flex flex-col items-start gap-1">
                  <ExperimentVerdictBadge verdict={result.verdict} />
                  <DataMaturityBadge maturity={result.maturity} withHint={false} />
                  {result.verdict === 'PROVISIONAL' ? (
                    <span className="text-xs text-warning">Kein Gewinner</span>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="align-top">
                {result.interpretationWarnings.length === 0 ? (
                  <span className="text-xs text-muted-foreground">Keine</span>
                ) : (
                  <InterpretationWarnings codes={result.interpretationWarnings} variant="compact" />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
