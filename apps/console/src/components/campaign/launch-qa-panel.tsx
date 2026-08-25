import Link from 'next/link';
import { HEALTH_STATUS_LABELS_DE, type HealthStatus, type LaunchCheckResult } from '@am/domain';
import { Badge, Button, cn, Section, StatusBadge } from '@am/ui';
import { ArrowUpRight } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import type { LaunchQaView } from '@/server/campaign-port';

/**
 * All twenty launch checks, and — separately — the two gates they feed.
 *
 * The distinction is the point: a missing credential reports
 * `AWAITING_EXTERNAL_INPUT`, which blocks going live but must never block
 * creating the paused Meta draft or the walkthrough. Only `FAIL` blocks the
 * draft gate (spec §29).
 */
export function LaunchQaPanel({ view }: { view: LaunchQaView }) {
  const { report } = view;
  const grouped = groupByStatus(report.checks);

  return (
    <div className="flex flex-col gap-8">
      <Section heading="Freigabetore" description="Zwei getrennte Tore, zwei getrennte Bedingungen.">
        <div className="grid gap-4 lg:grid-cols-2">
          <Gate
            testId="gate-meta-draft"
            title="Pausierten Meta-Entwurf erstellen"
            open={report.canCreateMetaDraft}
            openDe="Der pausierte Entwurf darf erstellt werden. Er liefert nichts aus."
            closedDe="Der Entwurf kann nicht erstellt werden, solange eine Prüfung fehlschlägt."
            blockers={report.blockingDe}
            note={
              report.awaitingExternalDe.length > 0
                ? `${report.awaitingExternalDe.length} Prüfungen warten auf externen Input. Für den pausierten Entwurf sind sie kein Hindernis.`
                : null
            }
          />
          <Gate
            testId="gate-go-live"
            title="Kampagne live schalten"
            open={report.canGoLive}
            openDe="Alle Prüfungen bestehen. Die Kampagne darf ausgeliefert werden."
            closedDe="Live-Schaltung blockiert, solange nicht jede Prüfung besteht."
            blockers={[...report.blockingDe, ...report.awaitingExternalDe]}
            note={null}
          />
        </div>
      </Section>

      <Section
        heading={`Prüfungen (${report.checks.length})`}
        description={`Zuletzt geprüft am ${formatDateTime(report.evaluated_at)}.`}
      >
        <div className="flex flex-col gap-6">
          {(['FAIL', 'AWAITING_EXTERNAL_INPUT', 'WARN', 'PASS'] as HealthStatus[]).map((status) =>
            grouped[status].length === 0 ? null : (
              <div key={status} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge kind="health" state={status} />
                  <span className="text-xs text-muted-foreground">
                    {grouped[status].length}{' '}
                    {grouped[status].length === 1 ? 'Prüfung' : 'Prüfungen'}
                  </span>
                </div>
                <ul className="flex flex-col gap-2">
                  {grouped[status].map((check) => (
                    <CheckRow key={check.key} check={check} />
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      </Section>
    </div>
  );
}

function CheckRow({ check }: { check: LaunchCheckResult }) {
  return (
    <li
      data-launch-check={check.key}
      data-launch-check-status={check.status}
      className={cn(
        'flex flex-col gap-2 rounded-lg border px-4 py-3 sm:flex-row sm:items-start sm:justify-between',
        check.status === 'FAIL' && 'border-destructive-border bg-destructive-surface',
        check.status === 'AWAITING_EXTERNAL_INPUT' && 'border-info-border bg-info-surface',
        check.status === 'WARN' && 'border-warning-border bg-warning-surface',
        check.status === 'PASS' && 'border-border bg-surface',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{check.labelDe}</p>
          <Badge tone="outline" size="sm">
            {HEALTH_STATUS_LABELS_DE[check.status]}
          </Badge>
          {check.blocksLiveOnly ? (
            <Badge tone="neutral" size="sm">
              Blockiert nur die Live-Schaltung
            </Badge>
          ) : null}
        </div>
        {check.detailDe ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{check.detailDe}</p>
        ) : null}
        {check.remediationDe ? (
          <p className="text-xs leading-relaxed text-foreground">
            <span className="font-medium">Zu tun: </span>
            {check.remediationDe}
          </p>
        ) : null}
      </div>
      {check.href ? (
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link href={check.href}>
            Zur Behebung
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      ) : null}
    </li>
  );
}

function Gate({
  testId,
  title,
  open,
  openDe,
  closedDe,
  blockers,
  note,
}: {
  testId: string;
  title: string;
  open: boolean;
  openDe: string;
  closedDe: string;
  blockers: readonly string[];
  note: string | null;
}) {
  return (
    <div
      data-gate={testId}
      data-gate-open={open ? 'true' : 'false'}
      className={cn(
        'flex flex-col gap-2 rounded-lg border-2 p-4',
        open ? 'border-success-border bg-success-surface' : 'border-warning-border bg-warning-surface',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <Badge tone={open ? 'success' : 'warning'}>{open ? 'Freigegeben' : 'Blockiert'}</Badge>
      </div>
      <p className="text-sm leading-relaxed text-foreground">{open ? openDe : closedDe}</p>
      {!open && blockers.length > 0 ? (
        <ul className="ml-4 list-disc space-y-1 text-sm text-foreground">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="text-xs leading-relaxed text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function groupByStatus(
  checks: readonly LaunchCheckResult[],
): Record<HealthStatus, LaunchCheckResult[]> {
  const grouped: Record<HealthStatus, LaunchCheckResult[]> = {
    PASS: [],
    WARN: [],
    FAIL: [],
    AWAITING_EXTERNAL_INPUT: [],
  };
  for (const check of checks) grouped[check.status].push(check);
  return grouped;
}
