import * as React from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  EmptyState,
  MetricTile,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@am/ui';
import { formatDate, formatNumber } from '@/lib/format';
import type { FunnelDropOff } from '@/server/analytics-port';
import { FunnelStepChart } from './funnel-step-chart';
import { rateBasisDe } from './metric-basis';

export interface FunnelDropOffViewProps {
  dropOff: FunnelDropOff;
}

interface FailureRow {
  stepKey: string;
  stepLabelDe: string;
  fieldId: string;
  errorCode: string;
  count: number;
  messageDe: string;
}

/**
 * Step-by-step drop-off for one funnel version.
 *
 * "Der Funnel konvertiert bei 3,6 %" is not actionable. "Schritt 3 (Zeitraum)
 * verliert 33,8 % der Sessions, die ihn sehen, und 60 der Fehler dort sind
 * REQUIRED auf dem Feld zeitraum" is. Everything here comes from `analyzeFunnel`.
 */
export function FunnelDropOffView({ dropOff }: FunnelDropOffViewProps): React.JSX.Element {
  const { analysis } = dropOff;

  const failureRows: FailureRow[] = analysis.steps.flatMap((step) =>
    step.validationFailures.map((failure) => ({
      stepKey: step.stepKey,
      stepLabelDe: `${step.index + 1}. ${step.label}`,
      fieldId: failure.fieldId,
      errorCode: failure.errorCode,
      count: failure.count,
      messageDe: failure.messageDe,
    })),
  );
  failureRows.sort((a, b) => b.count - a.count || a.fieldId.localeCompare(b.fieldId));

  const excludedEntries = Object.entries(analysis.excludedByTrafficKind).filter(
    ([, count]) => (count ?? 0) > 0,
  );

  return (
    <Section
      heading="Funnel-Abbrüche je Schritt"
      description={
        <>
          {dropOff.funnelLabelDe}. Auswertungsfenster {formatDate(dropOff.window.from)} bis{' '}
          {formatDate(dropOff.window.to)}.
        </>
      }
    >
      {dropOff.noteDe ? (
        <Alert tone="info">
          <AlertTitle className="text-sm font-semibold">Kürzeres Auswertungsfenster</AlertTitle>
          <AlertDescription className="text-sm">{dropOff.noteDe}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          value={{
            metric: 'funnel_sessions',
            numerator: analysis.funnelSessions,
            denominator: null,
            value: analysis.funnelSessions,
            currency: null,
            maturity: 'MATURE',
            attributionCoverage: null,
          }}
          denominatorLabel={`${formatNumber(analysis.formViews)} Formularaufrufe · ${formatNumber(
            analysis.formStarts,
          )} Formularstarts · ${formatNumber(analysis.submissions)} Leads`}
          hint="Eindeutige Sessions mit funnel_viewed. Nur PRODUCTION-Traffic wird gezählt."
        />
        <MetricTile
          metric="form_start_rate"
          value={analysis.formStartRate}
          maturity="MATURE"
          denominatorLabel={rateBasisDe(analysis.formStartRate, {
            numerator: 'Formularstarts',
            denominator: 'Sessions',
          })}
        />
        <MetricTile
          metric="submission_rate"
          value={analysis.submissionRate}
          maturity="MATURE"
          denominatorLabel={rateBasisDe(analysis.submissionRate, {
            numerator: 'Leads',
            denominator: 'Sessions',
          })}
        />
        <MetricTile
          label="Formular-Abschlussrate"
          value={analysis.formCompletionRate}
          maturity="MATURE"
          targetDirection="HIGHER_IS_BETTER"
          denominatorLabel={rateBasisDe(analysis.formCompletionRate, {
            numerator: 'Leads',
            denominator: 'Formularstarts',
          })}
          hint="Anteil der begonnenen Formulare, die abgesendet wurden."
        />
      </div>

      <FunnelStepChart
        steps={analysis.steps}
        descriptionDe={
          analysis.worstStepKey
            ? `Größter absoluter Verlust: ${
                analysis.steps.find((step) => step.stepKey === analysis.worstStepKey)?.label ??
                analysis.worstStepKey
              }.`
            : 'Kein Schritt verliert Sessions.'
        }
      />

      <Section heading="Validierungsfehler nach Feld und Fehlercode" headingLevel={3}>
        {failureRows.length === 0 ? (
          <EmptyState
            size="sm"
            title="Keine Validierungsfehler erfasst"
            description="Im Auswertungsfenster wurde kein form_validation_failed-Ereignis gezählt."
          />
        ) : (
          <Table caption="Validierungsfehler je Schritt, Feld und Fehlercode">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Schritt</TableHead>
                <TableHead scope="col">Feld</TableHead>
                <TableHead scope="col">Fehlercode</TableHead>
                <TableHead scope="col" className="text-right">
                  Anzahl
                </TableHead>
                <TableHead scope="col">Angezeigte Meldung</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failureRows.map((row) => (
                <TableRow key={`${row.stepKey}-${row.fieldId}-${row.errorCode}`}>
                  <TableCell>{row.stepLabelDe}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {row.fieldId}
                    </code>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {row.errorCode}
                    </code>
                  </TableCell>
                  <TableCell data-am-numeric="" className="text-right">
                    {formatNumber(row.count)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.messageDe}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {excludedEntries.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Vor der Auswertung ausgeschlossen:{' '}
          <span data-am-numeric="">{formatNumber(analysis.excludedEvents)}</span> Ereignisse aus
          nicht-produktivem Traffic (
          {excludedEntries
            .map(([kind, count]) => `${kind}: ${formatNumber(count ?? 0)}`)
            .join(', ')}
          ). Vorschau-, Bot-, interner und Test-Traffic erreicht keine Kennzahl.
        </p>
      ) : null}
    </Section>
  );
}
