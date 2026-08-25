'use client';

import * as React from 'react';
import Link from 'next/link';
import { APPROVAL_KIND_LABELS_DE } from '@am/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  cn,
  formatMoneyMinorDe,
  StatusBadge,
} from '@am/ui';
import { ArrowRight, CircleDot, Pause, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import type { CampaignHeaderView, CampaignReality } from '@/server/campaign-port';
import { REALITY, REALITY_ACCENT, REALITY_SURFACE } from './labels';
import { MetricValueInline } from './rate-value';

/**
 * The rail that never leaves the screen inside a Campaign Room.
 *
 * It answers, without scrolling: what state is this in, which angle and offer,
 * for whom, how is the primary metric doing, what does it cost per day, which
 * approvals hold, **what has to happen next**, and whether the providers are
 * actually in sync.
 */
export interface CampaignHeaderProps {
  header: CampaignHeaderView;
  /** Rendered on the right, e.g. a preview toggle or the advance action. */
  actions?: React.ReactNode;
}

export function CampaignHeader({ header, actions }: CampaignHeaderProps) {
  const invalidated = header.approvals.filter(
    (a) => a.approval.state !== 'PENDING' && a.approval.state !== 'REJECTED' && !a.valid,
  );

  return (
    <header
      data-campaign-header=""
      data-reality={header.reality}
      className={cn('flex flex-col gap-4 rounded-xl border-2 p-4', REALITY_SURFACE[header.reality])}
    >
      <RealityBanner reality={header.reality} />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-foreground">
            {header.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="campaign" state={header.state} />
            {header.errorState ? (
              <StatusBadge kind="campaignError" state={header.errorState} />
            ) : null}
            <Badge tone="outline">Angle: {header.angleName}</Badge>
            <Badge tone="outline">Offer: {header.offerName}</Badge>
            <Badge tone="outline">Zielgruppe: {header.audienceName}</Badge>
          </div>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HeaderFact label="Primärmetrik">
          <MetricValueInline value={header.primaryMetric} />
        </HeaderFact>
        <HeaderFact label="Aktuelles Tagesbudget">
          <span data-am-numeric="" className="font-medium tabular-nums text-foreground">
            {formatMoneyMinorDe(header.budget.amountMinor, header.budget.currency)}
          </span>
          <span className="text-xs text-muted-foreground"> pro Tag</span>
        </HeaderFact>
        <HeaderFact label="Freigabestatus">
          <ApprovalRail header={header} />
        </HeaderFact>
        <HeaderFact label="Provider-Sync">
          <div className="flex flex-wrap gap-1.5">
            {header.providerSync.map((sync) => (
              <span key={sync.provider} className="inline-flex items-center gap-1">
                <StatusBadge
                  kind="health"
                  state={sync.health}
                  suffix={<span className="sr-only">{sync.detailDe}</span>}
                />
                <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                  {sync.provider}
                </span>
              </span>
            ))}
          </div>
        </HeaderFact>
      </dl>

      <NextActionCallout header={header} />

      {invalidated.length > 0 ? (
        <Alert tone="warning" icon={<ShieldAlert aria-hidden="true" />}>
          <AlertTitle>Freigabe durch Änderung ungültig</AlertTitle>
          <AlertDescription>
            {invalidated
              .map((a) => APPROVAL_KIND_LABELS_DE[a.kind])
              .join(', ')}{' '}
            wurde nach der Freigabe inhaltlich geändert. Die Freigabe deckt den aktuellen Stand
            nicht mehr ab und muss erneut erteilt werden, bevor die Kampagne weitergeführt werden
            kann.
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Zuletzt geändert am {formatDateTime(header.updatedAt)}
      </p>
    </header>
  );
}

function HeaderFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3">
      <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-snug">{children}</dd>
    </div>
  );
}

function ApprovalRail({ header }: { header: CampaignHeaderView }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {header.approvals.map((status) => {
        const stale = status.approval.state === 'APPROVED' && !status.valid;
        const state = stale ? 'INVALIDATED' : status.approval.state;
        return (
          <li key={status.kind}>
            <StatusBadge
              kind="approval"
              state={state}
              size="sm"
              suffix={
                <span className="sr-only">
                  {' '}
                  – {APPROVAL_KIND_LABELS_DE[status.kind]}
                </span>
              }
              title={APPROVAL_KIND_LABELS_DE[status.kind]}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** The single most important line on the screen: what has to happen next. */
export function NextActionCallout({ header }: { header: CampaignHeaderView }) {
  const action = header.nextAction;
  return (
    <div
      data-next-action={action.key}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border bg-surface p-3.5 sm:flex-row sm:items-center sm:justify-between',
        action.blocked && 'border-warning-border bg-warning-surface',
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span aria-hidden="true" className={cn('mt-0.5', action.blocked ? 'text-warning' : 'text-brand')}>
          {action.blocked ? <TriangleAlert className="size-4.5" /> : <CircleDot className="size-4.5" />}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-semibold text-foreground">
            <span className="text-muted-foreground">Nächster erforderlicher Schritt: </span>
            {action.labelDe}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">{action.detailDe}</p>
          {action.blocked && action.blockedReasonDe ? (
            <p className="text-xs font-medium leading-relaxed text-warning">
              Blockiert: {action.blockedReasonDe}
            </p>
          ) : null}
        </div>
      </div>
      <Button asChild variant={action.blocked ? 'secondary' : 'primary'} size="sm" className="shrink-0">
        <Link href={action.href}>
          {action.blocked ? 'Blocker ansehen' : 'Jetzt erledigen'}
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );
}

/**
 * The visual separator between the four realities. It repeats the word, the
 * icon and a full German sentence — nobody has to read a colour to know whether
 * something is live.
 */
export function RealityBanner({ reality }: { reality: CampaignReality }) {
  const descriptor = REALITY[reality];
  const Icon = reality === 'LIVE' ? CircleDot : reality === 'ENDED' ? ShieldCheck : Pause;
  return (
    <div
      data-reality-banner={reality}
      role="status"
      className="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-2.5"
    >
      <span aria-hidden="true" className={cn('mt-0.5 shrink-0', REALITY_ACCENT[reality])}>
        <Icon className={cn('size-4.5', reality === 'LIVE' && 'animate-pulse')} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className={cn('text-sm font-bold uppercase tracking-wide', REALITY_ACCENT[reality])}>
          {descriptor.labelDe}
        </p>
        <p className="text-xs leading-relaxed text-foreground/80">{descriptor.explanationDe}</p>
      </div>
    </div>
  );
}
