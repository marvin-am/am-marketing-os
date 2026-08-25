'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataMaturityBadge,
  EmptyState,
  Section,
  StatusBadge,
} from '@am/ui';
import { ArrowRight, CheckCircle2, Sunrise } from 'lucide-react';
import {
  formatCoverage,
  formatCurrencyMinor,
  formatNumber,
  formatRelative,
} from '@/lib/format';
import type { ActiveCampaignSummary, TodayItem, TodaySeverity } from '@/server/ops-port';
import { blockingErrorCount, groupTodayItems } from './today-order';

/**
 * „Heute“ — the daily start page.
 *
 * Its job is to answer one question: what has to happen today, and in what
 * order. The ordering is the content, so it comes from `today-order.ts` rather
 * than from the arrangement of JSX, and a genuinely quiet day renders as a
 * quiet page instead of a dashboard that manufactures activity.
 */

const SEVERITY_LABELS_DE: Readonly<Record<TodaySeverity, string>> = {
  HIGH: 'Hoch',
  MEDIUM: 'Mittel',
  LOW: 'Niedrig',
};

const SEVERITY_TONES = {
  HIGH: 'destructive',
  MEDIUM: 'warning',
  LOW: 'neutral',
} as const;

export interface TodayBoardProps {
  generatedAt: string;
  activeCampaigns: readonly ActiveCampaignSummary[];
  items: readonly TodayItem[];
}

export function TodayBoard({ generatedAt, activeCampaigns, items }: TodayBoardProps) {
  const groups = React.useMemo(() => groupTodayItems(items), [items]);
  const errors = blockingErrorCount(items);

  return (
    <div className="flex flex-col gap-8">
      {errors > 0 ? (
        <Alert tone="destructive">
          <AlertTitle>
            {errors === 1
              ? '1 kritischer Fehler blockiert die Auswertung'
              : `${formatNumber(errors)} kritische Fehler blockieren die Auswertung`}
          </AlertTitle>
          <AlertDescription>
            Solange Tracking oder Synchronisation fehlerhaft sind, sind Leads, Abschlüsse und Umsätze
            unvollständig. Bitte zuerst diese Punkte bearbeiten.
          </AlertDescription>
        </Alert>
      ) : null}

      <ActiveCampaignStrip campaigns={activeCampaigns} />

      {groups.length === 0 ? (
        <EmptyState
          icon={<Sunrise />}
          title="Heute ist nichts offen."
          description={`Keine Fehler, keine offenen Freigaben, keine Empfehlungen. Stand: ${formatRelative(
            generatedAt,
          )}. Sobald etwas eintrifft, erscheint es hier — bis dahin gibt es nichts zu tun.`}
          action={
            <Link
              href="/kampagnen"
              className="text-sm font-medium text-brand underline-offset-4 hover:underline"
            >
              Zu den Kampagnen
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-8" data-testid="today-groups">
          {groups.map((group) => (
            <Section
              key={group.kind}
              heading={group.labelDe}
              description={group.hintDe}
              meta={<Badge tone="neutral">{formatNumber(group.items.length)}</Badge>}
              data-today-group={group.kind}
            >
              <ul className="flex flex-col gap-2">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <TodayItemRow item={item} />
                  </li>
                ))}
              </ul>
            </Section>
          ))}
        </div>
      )}
    </div>
  );
}

function TodayItemRow({ item }: { item: TodayItem }) {
  return (
    <Link
      href={item.href}
      data-today-item={item.id}
      data-today-kind={item.kind}
      className="group flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3.5 transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">{item.titleDe}</p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {item.badge ? <StatusBadge {...item.badge} size="sm" /> : null}
          <Badge tone={SEVERITY_TONES[item.severity]} size="sm">
            {SEVERITY_LABELS_DE[item.severity]}
          </Badge>
        </div>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{item.detailDe}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {item.campaignNameDe ? <span>{item.campaignNameDe}</span> : null}
        <span>{formatRelative(item.occurredAt)}</span>
        <span className="ml-auto inline-flex items-center gap-1 font-medium text-brand">
          {item.hrefLabelDe}
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </span>
      </div>
    </Link>
  );
}

function ActiveCampaignStrip({ campaigns }: { campaigns: readonly ActiveCampaignSummary[] }) {
  if (campaigns.length === 0) {
    return (
      <Section heading="Aktive Kampagnen">
        <EmptyState
          size="sm"
          icon={<CheckCircle2 />}
          title="Derzeit läuft keine Kampagne."
          description="Sobald eine Kampagne live geht, erscheinen hier Ausgaben, Leads und Datenreife des Tages."
        />
      </Section>
    );
  }

  return (
    <Section
      heading="Aktive Kampagnen"
      description="Ausgaben und Leads des laufenden Tages, mit der Reife der zugehörigen CRM-Kohorte."
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {campaigns.map((campaign) => (
          <Card key={campaign.id} className="h-full">
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="campaign" state={campaign.state} size="sm" />
                {campaign.errorState ? (
                  <StatusBadge kind="campaignError" state={campaign.errorState} size="sm" />
                ) : null}
              </div>
              <CardTitle className="text-sm">
                <Link href={campaign.href} className="hover:underline">
                  {campaign.nameDe}
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Ausgaben heute</dt>
                  <dd className="font-medium tabular-nums text-foreground">
                    {formatCurrencyMinor(campaign.spendTodayMinor, campaign.currency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Leads heute</dt>
                  <dd className="font-medium tabular-nums text-foreground">
                    {formatNumber(campaign.leadsToday)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">CPL</dt>
                  <dd className="font-medium tabular-nums text-foreground">
                    {formatCurrencyMinor(campaign.costPerLeadMinor, campaign.currency)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      Ziel {formatCurrencyMinor(campaign.targetCostPerLeadMinor, campaign.currency)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Zuordnung</dt>
                  <dd className="font-medium text-foreground">
                    {formatCoverage(campaign.attributionCoverage)}
                  </dd>
                </div>
              </dl>
              <DataMaturityBadge maturity={campaign.maturity} size="sm" />
            </CardContent>
          </Card>
        ))}
      </div>
    </Section>
  );
}
