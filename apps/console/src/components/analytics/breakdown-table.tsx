import * as React from 'react';
import { type MetricKey, type MetricValue } from '@am/domain';
import { AttributionCoverageBadge, DataMaturityBadge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, formatMetricValueDe, metricBasisDe } from '@am/ui';
import type { BreakdownRow } from '@/server/analytics-port';

const METRIC_LABELS: Readonly<Record<MetricKey, string>> = {
  impressions: 'Impressionen',
  link_clicks: 'Link-Klicks',
  ctr: 'CTR',
  cpc: 'CPC',
  cpm: 'CPM',
  spend: 'Spend',
  funnel_sessions: 'Sessions',
  form_start_rate: 'Formularstartrate',
  step_dropoff: 'Step-Abbruch',
  submission_rate: 'Submission-Rate',
  leads: 'Leads',
  cpl: 'CPL',
  vq_scheduled: 'Term. VQs',
  vq_scheduled_rate: 'VQ-Terminierung',
  show_rate: 'Show-Rate',
  qualified_vq: 'Qual. VQs',
  qualified_vq_rate: 'Qualifizierungsrate',
  cost_per_qualified_vq: 'Kosten/qual. VQ',
  opportunities: 'Opportunities',
  opportunity_rate: 'Opportunity-Rate',
  closed_won: 'Abschlüsse',
  close_rate: 'Abschlussquote',
  cac: 'CAC',
  revenue: 'Umsatz',
  roas: 'ROAS',
};

/** Columns shown for every breakdown. Order follows the funnel. */
const COLUMNS: readonly MetricKey[] = [
  'spend',
  'impressions',
  'link_clicks',
  'ctr',
  'cpc',
  'funnel_sessions',
  'leads',
  'submission_rate',
  'cpl',
  'vq_scheduled',
  'show_rate',
  'qualified_vq',
  'cost_per_qualified_vq',
  'closed_won',
  'cac',
  'revenue',
  'roas',
];

export function MetricCell({ value }: { value: MetricValue }): React.JSX.Element {
  const display = formatMetricValueDe(value.metric, value.value, value.currency, 'minor');
  return (
    <span className="flex flex-col items-end leading-tight">
      <span data-am-numeric="" className="font-medium text-foreground">
        {display}
      </span>
      <span data-am-numeric="" className="text-[0.6875rem] text-muted-foreground">
        {metricBasisDe(value)}
      </span>
    </span>
  );
}

export interface BreakdownTableProps {
  rows: readonly BreakdownRow[];
  captionDe: string;
  /** German label of the entity column, e.g. "Kampagne". */
  entityLabelDe: string;
  /** Rendered for rows that link somewhere, e.g. an experiment arm. */
  renderLink?: (row: BreakdownRow) => React.ReactNode;
}

/**
 * The authoritative view of a breakdown: every metric with its own basis, its
 * data maturity and its attribution coverage on the same row. The chart beside
 * it shows one measure; this shows all of them, which is what makes the chart
 * safe to keep to a single hue.
 */
export function BreakdownTable({
  rows,
  captionDe,
  entityLabelDe,
  renderLink,
}: BreakdownTableProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="Keine Einträge im gewählten Zeitraum"
        description="In diesem Zeitraum wurde auf dieser Ebene nichts ausgeliefert."
      />
    );
  }

  return (
    <Table caption={captionDe}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="min-w-56">
            {entityLabelDe}
          </TableHead>
          <TableHead scope="col">Datenreife</TableHead>
          <TableHead scope="col">Attribution</TableHead>
          {COLUMNS.map((key) => (
            <TableHead key={key} scope="col" className="text-right whitespace-nowrap">
              {METRIC_LABELS[key]}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell className="align-top">
              <span className="flex flex-col leading-tight">
                <span className="font-medium text-foreground">
                  {renderLink ? renderLink(row) : row.labelDe}
                </span>
                {row.contextDe ? (
                  <span className="text-xs text-muted-foreground">{row.contextDe}</span>
                ) : null}
              </span>
            </TableCell>
            <TableCell className="align-top">
              <DataMaturityBadge maturity={row.maturity} withHint={false} />
            </TableCell>
            <TableCell className="align-top">
              <AttributionCoverageBadge coverage={row.attributionCoverage} withHint={false} />
            </TableCell>
            {COLUMNS.map((key) => (
              <TableCell key={key} className="align-top text-right whitespace-nowrap">
                <MetricCell value={row.metrics[key]} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
