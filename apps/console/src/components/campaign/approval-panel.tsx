'use client';

import * as React from 'react';
import { APPROVAL_KIND_LABELS_DE, type CampaignState } from '@am/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  ApprovalCard,
  Button,
  ConfirmDialog,
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

/**
 * The exact Meta request a step would send, when it reaches Meta at all.
 *
 * Present ⇒ the step is an external action: it is confirmed against the payload
 * before anything runs, exactly as the recommendation path is. Absent ⇒ the
 * step only moves our own record and needs no such gate.
 */
export interface AdvanceExternalConfirm {
  /** Adapter operation, e.g. `meta.create_paused_draft_campaign`. */
  operation: string;
  payload: Record<string, unknown>;
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
  /** Set for a step that writes to Meta; drives the confirmation dialog. */
  externalConfirm?: AdvanceExternalConfirm | null;
}

/**
 * Taking the last step back.
 *
 * A rollback is legal and sometimes necessary, but it is never progress, so it
 * is carried separately from `AdvanceDescriptor` and rendered as its own,
 * confirmed control — never as the campaign's next step.
 */
export interface RollbackDescriptor {
  /** German label naming the state the campaign returns to. */
  labelDe: string;
  to: CampaignState;
  /** German sentence stating what happens, shown before anything is executed. */
  confirmDe: string;
  run: (input: { campaignId: string; to: CampaignState }) => Promise<ActionResult<CampaignHeaderView>>;
  /** False when the operator's role does not allow this step. */
  permitted: boolean;
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
  /** The way back out of the current state, rendered apart from the advance. */
  rollback?: RollbackDescriptor;
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
  rollback,
  approvalBlockedReasonDe = null,
}: ApprovalPanelProps) {
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [confirmingRollback, setConfirmingRollback] = React.useState(false);
  const [confirmingExternal, setConfirmingExternal] = React.useState(false);
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
  const undo = useAction(
    React.useCallback(
      (input: { campaignId: string; to: CampaignState }) =>
        rollback
          ? rollback.run(input)
          : Promise.resolve<ActionResult<CampaignHeaderView>>({
              status: 'error',
              code: 'NOT_AVAILABLE',
              messageDe: 'Für diesen Status ist kein Rückschritt hinterlegt.',
              retryable: false,
            }),
      [rollback],
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
          {advance.externalConfirm ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Dieser Schritt schreibt bei Meta. Sie sehen vor der Ausführung die vollständige
              Nutzlast.
            </p>
          ) : null}
          <div>
            <Button
              data-advance-action={advance.to}
              size="sm"
              disabled={advanceBlocked || transition.pending}
              loading={transition.pending}
              onClick={() =>
                advance.externalConfirm
                  ? setConfirmingExternal(true)
                  : void transition.execute({ campaignId, to: advance.to })
              }
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

      {advance?.externalConfirm ? (
        <ConfirmDialog
          open={confirmingExternal}
          onOpenChange={setConfirmingExternal}
          title={`${advance.labelDe} — an Meta senden`}
          description="Prüfen Sie, was genau an Meta gesendet würde. Es wird nichts ausgeführt, bevor Sie bestätigen."
          confirmPhrase="AUSFÜHREN"
          confirmLabel="An Meta senden"
          tone="destructive"
          pending={transition.pending}
          preview={
            <div className="flex flex-col gap-2">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Operation
              </p>
              <p className="font-mono text-xs text-foreground">
                {advance.externalConfirm.operation}
              </p>
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Nutzlast
              </p>
              <pre className="max-h-60 overflow-auto rounded-md bg-surface-sunken px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
                {JSON.stringify(advance.externalConfirm.payload, null, 2)}
              </pre>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Sind Meta-Schreibzugriffe deaktiviert, endet der Schritt als Dry-Run. Ein Dry-Run
                legt bei Meta nichts an und ändert den Status der Kampagne nicht.
              </p>
            </div>
          }
          onConfirm={async () => {
            await transition.execute({ campaignId, to: advance.to });
            setConfirmingExternal(false);
          }}
        />
      ) : null}

      {rollback ? (
        <div
          data-rollback-section=""
          className="flex flex-col gap-2 rounded-lg border border-dashed border-border-strong bg-surface-sunken p-4"
        >
          <p className="text-sm font-medium text-foreground">Schritt zurücknehmen</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{rollback.confirmDe}</p>
          {rollback.permitted ? (
            confirmingRollback ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  data-rollback-confirm={rollback.to}
                  size="sm"
                  variant="destructive"
                  loading={undo.pending}
                  disabled={undo.pending}
                  onClick={() => {
                    setConfirmingRollback(false);
                    void undo.execute({ campaignId, to: rollback.to });
                  }}
                >
                  Ja, zurücksetzen
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={undo.pending}
                  onClick={() => setConfirmingRollback(false)}
                >
                  Abbrechen
                </Button>
              </div>
            ) : (
              <div>
                <Button
                  data-rollback-action={rollback.to}
                  size="sm"
                  variant="secondary"
                  onClick={() => setConfirmingRollback(true)}
                >
                  {rollback.labelDe}
                </Button>
              </div>
            )
          ) : (
            <p className="text-xs text-muted-foreground">
              Ihre Rolle darf diesen Schritt nicht zurücknehmen.
            </p>
          )}
          <ActionFeedback
            phase={undo.phase}
            successDe="Status zurückgesetzt."
            pendingDe="Status wird zurückgesetzt …"
          />
        </div>
      ) : null}
    </div>
  );
}
