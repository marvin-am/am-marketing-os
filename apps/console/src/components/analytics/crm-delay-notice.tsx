import * as React from 'react';
import { Alert, AlertDescription, AlertTitle, DataMaturityBadge } from '@am/ui';
import { formatDate, formatNumber, formatRate, formatRateBasis, MATURITY_EXPLANATION_DE } from '@/lib/format';
import type { CrmDelayStatement, MetricSnapshot } from '@/server/analytics-port';

export interface CrmDelayNoticeProps {
  statement: CrmDelayStatement;
  /** The snapshot the tiles below are built from, for its maturity badge. */
  snapshot: MetricSnapshot;
}

/**
 * Which part of the selected period cannot be mature yet.
 *
 * Without this, the last three weeks of any period read as a collapse in
 * qualified VQs, opportunities and revenue. They are not: those outcomes have
 * not happened yet. The statement is deliberately quantified — days, share and
 * the exact cut-off date — rather than a vague "data may be incomplete".
 */
export function CrmDelayNotice({ statement, snapshot }: CrmDelayNoticeProps): React.JSX.Element {
  const share = statement.notYetMature;
  const tone = share.value !== null && share.value > 0 ? 'warning' : 'info';

  return (
    <Alert tone={tone}>
      <AlertTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <span>CRM-Verzug im gewählten Zeitraum</span>
        <DataMaturityBadge maturity={snapshot.maturity} />
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2 text-sm text-foreground">
        <p>
          <span data-am-numeric="">{formatRate(share)}</span> des Zeitraums (
          <span data-am-numeric="">{formatRateBasis(share)}</span> Tage) liegen noch im
          CRM-Reifefenster von <span data-am-numeric="">{formatNumber(statement.crmMaturityDays)}</span>{' '}
          Tagen. Terminierte VQs, Opportunities, Abschlüsse und Umsatz aus diesen Tagen sind noch
          nicht vollständig eingetroffen.
        </p>
        {statement.maturityCutoff ? (
          <p>
            Kohorten ab dem <strong>{formatDate(statement.maturityCutoff)}</strong> können frühestens{' '}
            {formatNumber(statement.crmMaturityDays)} Tage nach ihrem Eingang als reif gelten. Ein
            Ausbleiben von Abschlüssen in diesem Abschnitt ist erwartbar und darf nicht als
            schlechtes Ergebnis gelesen werden.
          </p>
        ) : null}
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <li data-am-numeric="">Reif: {formatNumber(statement.matureDays)} Tage</li>
          <li data-am-numeric="">Teilweise reif: {formatNumber(statement.partialDays)} Tage</li>
          <li data-am-numeric="">Unreif: {formatNumber(statement.immatureDays)} Tage</li>
        </ul>
        {statement.reasonsDe.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
            {statement.reasonsDe.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground">{MATURITY_EXPLANATION_DE[snapshot.maturity]}</p>
      </AlertDescription>
    </Alert>
  );
}
