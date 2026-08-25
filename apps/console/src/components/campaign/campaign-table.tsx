import Link from 'next/link';
import {
  Badge,
  Button,
  cn,
  EmptyState,
  formatMoneyMinorDe,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@am/ui';
import { ArrowRight, Rocket } from 'lucide-react';
import { formatDate } from '@/lib/format';
import type { CampaignListPage, CampaignListRow } from '@/server/campaign-port';
import { campaignTabHref } from '@/server/campaign-port';
import { REALITY, REALITY_ACCENT } from './labels';
import { MetricValueInline } from './rate-value';

export interface CampaignTableProps {
  page: CampaignListPage;
  /** True when the operator has narrowed the list and got nothing back. */
  filtered: boolean;
  /** Preserves the current filter in the pagination links. */
  buildPageHref: (page: number) => string;
}

export function CampaignTable({ page, filtered, buildPageHref }: CampaignTableProps) {
  if (page.rows.length === 0) {
    return filtered ? (
      <EmptyState
        title="Keine Kampagne entspricht diesem Filter."
        description="Setzen Sie die Filter zurück oder erweitern Sie den Zeitraum. Die Auswahl steht in der Adresszeile und kann geteilt werden."
        action={
          <Button asChild variant="secondary">
            <Link href="/kampagnen">Filter zurücksetzen</Link>
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<Rocket />}
        title="Noch keine Kampagne angelegt."
        description={
          <>
            Eine Kampagne beginnt mit einem Angle und einem Offer. Legen Sie unter „Library" den
            Angle und den Offer an, starten Sie damit den Kampagnenvorschlag und geben Sie die
            Strategie frei — danach führt der Kampagnenraum Schritt für Schritt bis zum pausierten
            Meta-Entwurf.
          </>
        }
        action={
          <Button asChild>
            <Link href="/library">Zur Library</Link>
          </Button>
        }
        secondaryAction={
          <Button asChild variant="secondary">
            <Link href="/heute">Offene Aufgaben ansehen</Link>
          </Button>
        }
      />
    );
  }

  const lastPage = Math.max(1, Math.ceil(page.total / page.pageSize));

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Kampagne</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Angle</TableHead>
              <TableHead scope="col">Offer</TableHead>
              <TableHead scope="col">Primärmetrik</TableHead>
              <TableHead scope="col">Tagesbudget</TableHead>
              <TableHead scope="col">Nächster Schritt</TableHead>
              <TableHead scope="col">Provider-Sync</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Öffnen</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.map((row) => (
              <CampaignRow key={row.id} row={row} />
            ))}
          </TableBody>
        </Table>
      </div>

      <nav aria-label="Seiten" className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground" role="status">
          Seite {page.page} von {lastPage} · {page.total} Kampagnen insgesamt
        </p>
        <div className="flex gap-2">
          <Button
            asChild={page.page > 1}
            variant="secondary"
            size="sm"
            disabled={page.page <= 1}
          >
            {page.page > 1 ? (
              <Link href={buildPageHref(page.page - 1)}>Vorherige Seite</Link>
            ) : (
              <span>Vorherige Seite</span>
            )}
          </Button>
          <Button
            asChild={page.page < lastPage}
            variant="secondary"
            size="sm"
            disabled={page.page >= lastPage}
          >
            {page.page < lastPage ? (
              <Link href={buildPageHref(page.page + 1)}>Nächste Seite</Link>
            ) : (
              <span>Nächste Seite</span>
            )}
          </Button>
        </div>
      </nav>
    </div>
  );
}

function CampaignRow({ row }: { row: CampaignListRow }) {
  const reality = REALITY[row.reality];
  return (
    <TableRow data-campaign-row={row.id} data-reality={row.reality}>
      <TableCell>
        <div className="flex flex-col gap-1">
          <Link
            href={campaignTabHref(row.id, 'strategie')}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {row.name}
          </Link>
          <span className={cn('text-[0.6875rem] font-semibold uppercase tracking-wide', REALITY_ACCENT[row.reality])}>
            {reality.labelDe}
          </span>
          <span className="text-xs text-muted-foreground">
            Geändert am {formatDate(row.updatedAt)}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <StatusBadge kind="campaign" state={row.state} />
          {row.errorState ? <StatusBadge kind="campaignError" state={row.errorState} size="sm" /> : null}
        </div>
      </TableCell>
      <TableCell className="max-w-56 text-sm text-foreground">{row.angleName}</TableCell>
      <TableCell className="max-w-48 text-sm text-foreground">{row.offerName}</TableCell>
      <TableCell>
        <MetricValueInline value={row.primaryMetric} />
      </TableCell>
      <TableCell>
        <span data-am-numeric="" className="tabular-nums text-foreground">
          {formatMoneyMinorDe(row.budget.amountMinor, row.budget.currency)}
        </span>
      </TableCell>
      <TableCell className="max-w-64">
        <div className="flex flex-col gap-1">
          <Link
            href={row.nextAction.href}
            className={cn(
              'text-sm font-medium underline-offset-4 hover:underline',
              row.nextAction.blocked ? 'text-warning' : 'text-foreground',
            )}
          >
            {row.nextAction.labelDe}
          </Link>
          {row.nextAction.blocked && row.nextAction.blockedReasonDe ? (
            <span className="text-xs leading-snug text-warning">
              Blockiert: {row.nextAction.blockedReasonDe}
            </span>
          ) : (
            <span className="text-xs leading-snug text-muted-foreground">
              {row.nextAction.detailDe}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          {row.providerSync.map((sync) => (
            <span key={sync.provider} className="inline-flex items-center gap-1.5">
              <Badge tone="outline" size="sm">
                {sync.provider}
              </Badge>
              <StatusBadge kind="health" state={sync.health} size="sm" />
            </span>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <Button asChild variant="ghost" size="sm">
          <Link href={campaignTabHref(row.id, 'strategie')}>
            Öffnen
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}
