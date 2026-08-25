'use client';

import * as React from 'react';
import { APPROVAL_KIND_LABELS_DE, type CampaignState } from '@am/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  ApprovalCard,
  Button,
  Label,
  Textarea,
} from '@am/ui';
import { ShieldAlert } from 'lucide-react';
import type { ActionResult } from '@/lib/action-result';
import type { ApprovalStatus, CampaignHeaderView } from '@/server/campaign-port';
import { ActionFeedback, useAction } from './action-feedback';

export interface ApprovalDecisionRunner {
  (input: {
    campaignId: string;
    decision: 'APPROVE' | 'REJECT';
    contentHash: string;
    reasonDe?: string;
  }): Promise<ActionResult<ApprovalStatus>>;
}

export interface AdvanceDescriptor {
  /** German label of the button, e.g. „Zur Asset-Erzeugung freigeben". */
  labelDe: string;
  to: CampaignState;
  run: (input: { campaignId: string; to: CampaignState }) => Promise<ActionResult<CampaignHeaderView>>;
  /** False when the operator's role does not allow this step. */
  permitted: boolean;
  /** German reason the step is unavailable for reasons other than permission. */
  blockedReasonDe?: string | null;
}

export interface ApprovalPanelProps {
  campaignId: string;
  status: ApprovalStatus;
  /** False when the operator's role may not grant this approval. */
  canDecide: boolean;
  /** German sentence naming a role that may, shown when `canDecide` is false. */
  requiredRoleDe: string;
  decide: ApprovalDecisionRunner;
  /** The state change this approval unlocks, rendered next to the card. */
  advance?: AdvanceDescriptor;
  /** Extra German reason approval itself is blocked (e.g. the asset gate). */
  approvalBlockedReasonDe?: string | null;
}

/**
 * Approve / reject one approval kind, plus the state change it unlocks.
 *
 * An approval only covers the exact content hash it was granted against. When
 * the content changed afterwards the card says so in German, the approval is
 * shown as invalid, **and the advance action is disabled** — because advancing
 * on a stale approval is precisely what content-hash invalidation exists to
 * prevent (spec §4.1, acceptance criterion 25).
 */
export function ApprovalPanel({
  campaignId,
  status,
  canDecide,
  requiredRoleDe,
  decide,
  advance,
  approvalBlockedReasonDe = null,
}: ApprovalPanelProps) {
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const decision = useAction(decide);
  const transition = useAction(
    React.useCallback(
      (input: { campaignId: string; to: CampaignState }) =>
        advance
          ? advance.run(input)
          : Promise.resolve<ActionResult<CampaignHeaderView>>({
              status: 'error',
              code: 'NOT_AVAILABLE',
              messageDe: 'Für diesen Status ist kein weiterführender Schritt hinterlegt.',
              retryable: false,
            }),
      [advance],
    ),
  );

  const stale = status.approval.state === 'APPROVED' && !status.valid;
  const invalid = stale || status.approval.state === 'INVALIDATED';
  const advanceBlocked =
    !status.valid || Boolean(advance?.blockedReasonDe) || advance?.permitted === false;

  return (
    <div className="flex flex-col gap-4">
      <ApprovalCard
        approval={status.approval}
        approverName={status.approverName}
        currentContentHash={status.currentContentHash}
        actions={
          canDecide ? (
            <>
              <Button
                size="sm"
                loading={decision.pending && !rejecting}
                disabled={decision.pending || approvalBlockedReasonDe !== null}
                onClick={() => {
                  setRejecting(false);
                  void decision.execute({
                    campaignId,
                    decision: 'APPROVE',
                    contentHash: status.currentContentHash,
                  });
                }}
              >
                {invalid ? 'Erneut freigeben' : 'Freigeben'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={decision.pending}
                onClick={() => setRejecting((value) => !value)}
              >
                {rejecting ? 'Ablehnung abbrechen' : 'Ablehnen'}
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Ihre Rolle darf diese Freigabe nicht erteilen. Zuständig ist: {requiredRoleDe}.
            </p>
          )
        }
      />

      {invalid ? (
        <Alert tone="warning" icon={<ShieldAlert aria-hidden="true" />} data-approval-invalid="">
          <AlertTitle>
            Freigabe „{APPROVAL_KIND_LABELS_DE[status.kind]}" ist durch eine Änderung ungültig
          </AlertTitle>
          <AlertDescription>
            {status.invalidatedByDe ??
              'Der freigegebene Inhalt wurde nach der Freigabe geändert. Diese Freigabe deckt den aktuellen Stand nicht mehr ab.'}{' '}
            Der nächste Schritt bleibt gesperrt, bis der aktuelle Stand erneut freigegeben wurde.
          </AlertDescription>
        </Alert>
      ) : null}

      {approvalBlockedReasonDe ? (
        <Alert tone="warning">
          <AlertTitle>Freigabe derzeit nicht möglich</AlertTitle>
          <AlertDescription>{approvalBlockedReasonDe}</AlertDescription>
        </Alert>
      ) : null}

      {rejecting && canDecide ? (
        <form
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void decision.execute({
              campaignId,
              decision: 'REJECT',
              contentHash: status.currentContentHash,
              reasonDe: reason,
            });
          }}
        >
          <Label htmlFor={`reject-${status.kind}`} required>
            Begründung der Ablehnung
          </Label>
          <Textarea
            id={`reject-${status.kind}`}
            value={reason}
            required
            minLength={5}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Was muss geändert werden, damit freigegeben werden kann?"
          />
          <div>
            <Button type="submit" variant="destructive" size="sm" loading={decision.pending}>
              Ablehnung speichern
            </Button>
          </div>
        </form>
      ) : null}

      <ActionFeedback
        phase={decision.phase}
        successDe={`Freigabe „${APPROVAL_KIND_LABELS_DE[status.kind]}" gespeichert.`}
        pendingDe="Freigabe wird gespeichert …"
      />

      {advance ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
          <p className="text-sm font-medium text-foreground">Nächster Schritt im Kampagnenablauf</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {advanceBlocked
              ? advance.permitted === false
                ? 'Ihre Rolle darf diesen Schritt nicht ausführen.'
                : (advance.blockedReasonDe ??
                  'Der Schritt ist gesperrt, solange keine gültige Freigabe für den aktuellen Stand vorliegt.')
              : 'Der Schritt kann jetzt ausgeführt werden.'}
          </p>
          <div>
            <Button
              data-advance-action={advance.to}
              size="sm"
              disabled={advanceBlocked || transition.pending}
              loading={transition.pending}
              onClick={() => void transition.execute({ campaignId, to: advance.to })}
            >
              {advance.labelDe}
            </Button>
          </div>
          <ActionFeedback
            phase={transition.phase}
            successDe="Status geändert."
            pendingDe="Status wird geändert …"
          />
        </div>
      ) : null}
    </div>
  );
}
