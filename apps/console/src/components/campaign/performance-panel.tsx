'use client';

import * as React from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Badge,
  DataMaturityBadge,
  EmptyState,
  formatMoneyMinorDe,
  MetricTile,
  NO_VALUE,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@am/ui';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import type { LivePerformanceView, PerformanceBreakdownRow } from '@/server/campaign-port';
import { REALITY } from './labels';
import { RateValue } from './rate-value';

/**
 * Delivery over time, then the same numbers split by creative and by funnel
 * arm. Every rate carries its numerator and denominator; every block carries
 * its data maturity, so nobody reads a curve without its reliability.
 */
export function PerformancePanel({ view }: { view: LivePerformanceView }) {
  if (view.series.length === 0) {
    return (
      <EmptyState
        title="Noch keine Auslieferung."
        description={`${REALITY[view.reality].explanationDe} Sobald ausgeliefert wird, erscheinen hier Spend, Impressionen, Klicks, Sessions, Formularstarts, Submissions und CPL im Zeitverlauf.`}
      />
    );
  }

  const chartData = view.series.map((point) => ({
    date: point.date,
    spend: point.spendMinor / 100,
    clicks: point.clicks,
    sessions: point.sessions,
    submissions: point.submissions,
    cpl: point.cplMinor === null ? null : point.cplMinor / 100,
    ctr: point.ctr.value === null ? null : point.ctr.value * 100,
  }));

  return (
    <div className="flex flex-col gap-8">
      <Section
        heading="Kennzahlen gesamt"
        meta={<DataMaturityBadge maturity={view.maturity} />}
        description={
          view.lastUpdatedAt
            ? `Zuletzt aktualisiert am ${formatDateTime(view.lastUpdatedAt)}.`
            : undefined
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {view.totals.map((metric) => (
            <MetricTile key={metric.metric} value={metric} />
          ))}
        </div>
      </Section>

      <Section heading="Verlauf" description="Tageswerte im gewählten Zeitraum.">
        <div className="flex flex-col gap-6">
          <ChartBlock
            title="Spend und CPL in Euro"
            data={chartData}
            lines={[
              { key: 'spend', nameDe: 'Spend (€)', color: 'var(--color-brand, #4f46e5)' },
              { key: 'cpl', nameDe: 'CPL (€)', color: 'var(--color-warning, #b45309)' },
            ]}
          />
          <ChartBlock
            title="Klicks, Sessions, Formularabschlüsse"
            data={chartData}
            lines={[
              { key: 'clicks', nameDe: 'Link-Klicks', color: 'var(--color-info, #0369a1)' },
              { key: 'sessions', nameDe: 'Funnel-Sessions', color: 'var(--color-brand, #4f46e5)' },
              { key: 'submissions', nameDe: 'Submissions', color: 'var(--color-success, #15803d)' },
            ]}
          />
        </div>
      </Section>

      <Section heading="Nach Creative">
        <BreakdownTable rows={view.byCreative} firstColumnDe="Creative" currency={view.currency} />
      </Section>

      <Section heading="Nach Funnelarm">
        <BreakdownTable rows={view.byFunnelArm} firstColumnDe="Funnelarm" currency={view.currency} />
      </Section>
    </div>
  );
}

interface ChartLine {
  key: string;
  nameDe: string;
  color: string;
}

function ChartBlock({
  title,
  data,
  lines,
}: {
  title: string;
  data: Array<Record<string, string | number | null>>;
  lines: ChartLine[];
}) {
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </figcaption>
      <div className="h-64 w-full rounded-lg border border-border bg-surface p-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #e5e7eb)" />
            <XAxis
              dataKey="date"
              tickFormatter={(value: string) => formatDate(value)}
              tick={{ fontSize: 11 }}
              stroke="var(--color-muted-foreground, #6b7280)"
            />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground, #6b7280)" />
            {/* Recharts' formatter signature carries five arguments; only the
                first two are used here, so the parameters stay contextually
                typed rather than being narrowed by hand. */}
            <Tooltip
              labelFormatter={(value) => formatDate(String(value))}
              formatter={(value, name) => [
                typeof value === 'number' ? formatNumber(value, 2) : NO_VALUE,
                name ?? '',
              ]}
            />
            <Legend />
            {lines.map((line) => (
              <Line
                key={line.key}
                type="monotone"
                dataKey={line.key}
                name={line.nameDe}
                stroke={line.color}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function BreakdownTable({
  rows,
  firstColumnDe,
  currency,
}: {
  rows: PerformanceBreakdownRow[];
  firstColumnDe: string;
  currency: string;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="Keine Aufschlüsselung verfügbar."
        description="Sobald Auslieferung stattfindet, erscheinen hier die Werte je Arm."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{firstColumnDe}</TableHead>
            <TableHead scope="col">Spend</TableHead>
            <TableHead scope="col">Impressionen</TableHead>
            <TableHead scope="col">CTR</TableHead>
            <TableHead scope="col">Sessions</TableHead>
            <TableHead scope="col">Submission-Rate</TableHead>
            <TableHead scope="col">CPL</TableHead>
            <TableHead scope="col">Datenreife</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} data-breakdown-row={row.id}>
              <TableCell className="font-medium text-foreground">{row.labelDe}</TableCell>
              <TableCell data-am-numeric="" className="tabular-nums">
                {formatMoneyMinorDe(row.spendMinor, currency)}
              </TableCell>
              <TableCell data-am-numeric="" className="tabular-nums">
                {formatNumber(row.impressions)}
              </TableCell>
              <TableCell>
                <RateValue rate={row.ctr} stacked fractionDigits={2} />
              </TableCell>
              <TableCell data-am-numeric="" className="tabular-nums">
                {formatNumber(row.sessions)}
              </TableCell>
              <TableCell>
                <RateValue rate={row.submissionRate} stacked />
              </TableCell>
              <TableCell data-am-numeric="" className="tabular-nums">
                {row.cplMinor === null ? (
                  <span className="text-muted-foreground">– (keine Submissions)</span>
                ) : (
                  formatMoneyMinorDe(row.cplMinor, currency)
                )}
              </TableCell>
              <TableCell>
                <DataMaturityBadge maturity={row.maturity} withHint={false} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-2 text-xs text-muted-foreground">
        <Badge tone="outline" size="sm">
          Hinweis
        </Badge>{' '}
        Alle Raten werden mit Zähler und Nenner ausgewiesen. Ein Nenner von null ergibt „–", nie
        „0 %".
      </p>
    </div>
  );
}
