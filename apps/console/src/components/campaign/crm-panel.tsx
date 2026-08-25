'use client';

import * as React from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AttributionCoverageBadge,
  Badge,
  Button,
  DataMaturityBadge,
  EmptyState,
  formatMoneyMinorDe,
  Section,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@am/ui';
import { RefreshCcw } from 'lucide-react';
import { formatDateTime, formatNumber } from '@/lib/format';
import type { ActionResult } from '@/lib/action-result';
import type { LeadRow, LeadsSalesView } from '@/server/campaign-port';
import { ActionFeedback, useAction } from './action-feedback';
import { ATTRIBUTION_LEVEL_LABELS_DE, VQ_STATUS_LABELS_DE } from './labels';
import { RateValue } from './rate-value';

export interface LeadSyncRetryRunner {
  (input: { campaignId: string; leadId: string }): Promise<ActionResult<LeadRow>>;
}

/**
 * The CRM funnel from lead to closed won, and every lead's sync state.
 *
 * Maturity and attribution coverage are shown at every stage rather than once
 * at the top: the later a stage sits, the less mature it is, and a single
 * badge on the page would hide exactly that (spec §4.3, §21).
 */
export function CrmPanel({
  view,
  canRetry,
  retry,
}: {
  view: LeadsSalesView;
  canRetry: boolean;
  retry: LeadSyncRetryRunner;
}) {
  if (view.stages.length === 0) {
    return (
      <EmptyState
        title="Noch keine Leads."
        description="Sobald das erste Formular abgeschlossen wird, erscheint hier die vollständige CRM-Strecke von Lead bis Abschluss — jeweils mit Datenreife und Attributionsabdeckung."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {view.maturityRemainingDays > 0 ? (
        <Alert tone="info">
          <AlertTitle>CRM-Ergebnisse sind noch nicht reif</AlertTitle>
          <AlertDescription>
            Das hinterlegte Reifefenster beträgt {view.crmMaturityDays} Tage. Der jüngsten Kohorte
            fehlen noch {view.maturityRemainingDays} Tage. Bis dahin wird kein Gewinner ausgerufen
            und nicht skaliert.
          </AlertDescription>
        </Alert>
      ) : null}

      <Section
        heading="CRM-Strecke"
        description="Jede Stufe mit ihrer Übergangsrate, dem Zähler-Nenner-Paar, der Datenreife und der Attributionsabdeckung."
      >
        <ul className="flex flex-col gap-2">
          {view.stages.map((stage) => (
            <li
              key={stage.key}
              data-crm-stage={stage.key}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-baseline gap-3">
                <span data-am-numeric="" className="text-lg font-semibold tabular-nums text-foreground">
                  {formatNumber(stage.count)}
                </span>
                <span className="text-sm font-medium text-foreground">{stage.labelDe}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <RateValue rate={stage.conversion} basisLabelDe="Übergang" />
                <DataMaturityBadge maturity={stage.maturity} withHint={false} />
                <AttributionCoverageBadge coverage={stage.attributionCoverage} withHint={false} />
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3">
          <span className="text-sm font-medium text-foreground">Attribuierter Umsatz</span>
          <span data-am-numeric="" className="text-lg font-semibold tabular-nums text-foreground">
            {formatMoneyMinorDe(view.revenue.amountMinor, view.revenue.currency)}
          </span>
          <DataMaturityBadge maturity={view.revenueMaturity} />
          <AttributionCoverageBadge coverage={view.attributionCoverage} />
        </div>
      </Section>

      <Section
        heading={`Leads (${view.leads.length})`}
        description="Pseudonymisierte Darstellung — Namen, E-Mail-Adressen und Telefonnummern verlassen den CRM-Kontext nicht."
        meta={
          view.failedSyncCount > 0 ? (
            <Badge tone="warning">{view.failedSyncCount} fehlgeschlagene Übertragungen</Badge>
          ) : null
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Lead</TableHead>
                <TableHead scope="col">Eingegangen</TableHead>
                <TableHead scope="col">VQ-Status</TableHead>
                <TableHead scope="col">Attribution</TableHead>
                <TableHead scope="col">Creative / Funnelarm</TableHead>
                <TableHead scope="col">HubSpot-Sync</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Aktion</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.leads.map((lead) => (
                <LeadTableRow
                  key={lead.id}
                  campaignId={view.campaignId}
                  lead={lead}
                  canRetry={canRetry}
                  retry={retry}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
    </div>
  );
}

function LeadTableRow({
  campaignId,
  lead,
  canRetry,
  retry,
}: {
  campaignId: string;
  lead: LeadRow;
  canRetry: boolean;
  retry: LeadSyncRetryRunner;
}) {
  const action = useAction(retry);
  const retryable = lead.syncStatus === 'FAILED_RETRYING' || lead.syncStatus === 'DEAD_LETTER';

  return (
    <TableRow data-lead={lead.id} data-sync-status={lead.syncStatus}>
      <TableCell className="font-medium text-foreground">{lead.labelDe}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatDateTime(lead.createdAt)}
      </TableCell>
      <TableCell>
        <Badge tone="neutral" size="sm">
          {VQ_STATUS_LABELS_DE[lead.vqStatus]}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge tone="outline" size="sm">
          {ATTRIBUTION_LEVEL_LABELS_DE[lead.attributionLevel]}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {lead.creativeLabelDe ?? '–'}
        <br />
        {lead.funnelArmLabelDe ?? '–'}
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <StatusBadge
            kind="sync"
            state={lead.syncStatus}
            suffix={lead.syncAttempts > 0 ? <span>· {lead.syncAttempts} Versuche</span> : null}
          />
          {lead.lastSyncError ? (
            <span className="text-xs leading-snug text-destructive">{lead.lastSyncError}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        {retryable ? (
          canRetry ? (
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={action.pending}
                disabled={action.pending}
                onClick={() => void action.execute({ campaignId, leadId: lead.id })}
              >
                <RefreshCcw aria-hidden="true" />
                Erneut übertragen
              </Button>
              <ActionFeedback
                phase={action.phase}
                successDe="Lead erneut an HubSpot übertragen."
                pendingDe="Übertragung läuft …"
              />
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              Wiederholung erfordert die Rolle RevOps.
            </span>
          )
        ) : null}
      </TableCell>
    </TableRow>
  );
}
