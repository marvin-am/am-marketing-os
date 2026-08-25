'use client';

import * as React from 'react';
import {
  APPROVAL_KIND_LABELS_DE,
  isApprovalValid,
  type Approval,
  type ApprovalState,
} from '@am/domain';
import { ShieldAlert, UserCheck } from 'lucide-react';
import { cn } from '../lib/cn';
import { formatDateTimeDe } from '../lib/format';
import { Alert, AlertDescription, AlertTitle } from './alert';
import { StatusBadge, type StatusBadgeProps } from './status-badge';

export interface ApprovalBadgeProps extends Omit<StatusBadgeProps, 'kind' | 'state'> {
  state: ApprovalState;
}

/** The approval-specific reading of `StatusBadge`. */
export const ApprovalBadge = React.forwardRef<HTMLSpanElement, ApprovalBadgeProps>(
  function ApprovalBadge({ state, ...props }, ref) {
    return <StatusBadge ref={ref} kind="approval" state={state} {...props} />;
  },
);

export interface ApprovalCardProps extends React.HTMLAttributes<HTMLDivElement> {
  approval: Approval;
  /** Display name of `approval.approved_by`, resolved by the caller. */
  approverName?: string | null;
  /**
   * Content hash of what is on screen right now. When it differs from the
   * approved hash the card shows the invalidation warning, because an approval
   * only ever covers the exact content it was given (spec §4.1).
   */
  currentContentHash?: string | null;
  /** Approve / reject buttons, supplied by the page that owns the permission. */
  actions?: React.ReactNode;
}

export const ApprovalCard = React.forwardRef<HTMLDivElement, ApprovalCardProps>(
  function ApprovalCard(
    { className, approval, approverName, currentContentHash = null, actions, ...props },
    ref,
  ) {
    const staleByHash =
      approval.state === 'APPROVED' &&
      currentContentHash !== null &&
      !isApprovalValid(approval, currentContentHash);
    const invalidated = approval.state === 'INVALIDATED' || approval.invalidated_at !== null;
    const showWarning = invalidated || staleByHash;

    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col gap-3 rounded-lg border bg-surface p-4',
          showWarning ? 'border-warning-border' : 'border-border',
          className,
        )}
        {...props}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-foreground">
              {APPROVAL_KIND_LABELS_DE[approval.kind]}
            </h3>
            <p className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {approval.state === 'APPROVED' || approval.state === 'INVALIDATED' ? (
                <>
                  <UserCheck aria-hidden="true" className="size-3.5" />
                  <span>
                    Freigegeben von {approverName ?? approval.approved_by ?? 'unbekannt'} am{' '}
                    {formatDateTimeDe(approval.approved_at)}
                  </span>
                </>
              ) : (
                <span>Angelegt am {formatDateTimeDe(approval.created_at)}</span>
              )}
            </p>
          </div>
          <ApprovalBadge state={approval.state} />
        </div>

        {approval.state === 'REJECTED' && approval.rejected_reason_de ? (
          <Alert tone="destructive">
            <AlertTitle>Ablehnungsgrund</AlertTitle>
            <AlertDescription>{approval.rejected_reason_de}</AlertDescription>
          </Alert>
        ) : null}

        {showWarning ? (
          <Alert tone="warning" icon={<ShieldAlert aria-hidden="true" />}>
            <AlertTitle>Durch Änderung ungültig</AlertTitle>
            <AlertDescription>
              {approval.invalidated_reason_de ??
                'Der freigegebene Inhalt wurde nach der Freigabe geändert. Diese Freigabe deckt den aktuellen Stand nicht mehr ab und muss erneut erteilt werden.'}
              {approval.invalidated_at ? (
                <span className="mt-1 block text-xs opacity-80">
                  Ungültig seit {formatDateTimeDe(approval.invalidated_at)}
                </span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    );
  },
);
