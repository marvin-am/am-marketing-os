import { notFound } from 'next/navigation';
import { APPROVAL_PERMISSIONS } from '@am/domain';
import { Section } from '@am/ui';
import { advanceOptionFor } from '@/components/campaign/advance';
import { ApprovalPanel } from '@/components/campaign/approval-panel';
import { assetGateBlockedReasonDe } from '@/components/campaign/gates';
import { LaunchQaPanel } from '@/components/campaign/launch-qa-panel';
import { requireUser } from '@/lib/action';
import { can, ROLE_LABELS_DE, rolesWithPermission } from '@/lib/permissions';
import { getCampaignPort } from '@/server/campaign-fixtures';
import { advanceCampaign, decidePublishApproval, publishCampaign } from '../actions';

export const dynamic = 'force-dynamic';

export default async function LaunchQaPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser('campaign.read');
  const { id } = await params;

  const port = getCampaignPort();
  const [view, header, board] = await Promise.all([
    port.getLaunchQa(id),
    port.getHeader(id, false),
    port.getCreativeBoard(id),
  ]);
  if (!view || !header) notFound();

  const option = advanceOptionFor('launch-qa', header.state);
  const gateOpen =
    option === null
      ? false
      : option.to === 'LIVE'
        ? view.report.canGoLive
        : view.report.canCreateMetaDraft;

  const diversityBlock = board ? assetGateBlockedReasonDe(board) : null;
  const blockedReasonDe =
    diversityBlock ??
    (option !== null && !gateOpen
      ? option.to === 'LIVE'
        ? `Live-Schaltung blockiert durch: ${[...view.report.blockingDe, ...view.report.awaitingExternalDe].join(', ')}.`
        : `Blockiert durch: ${view.report.blockingDe.join(', ')}.`
      : null);

  const publishApproval = header.approvals.find((approval) => approval.kind === 'PUBLISH');

  return (
    <div className="flex flex-col gap-8">
      <LaunchQaPanel view={view} />

      {publishApproval ? (
        <Section
          heading="Freigabe der Veröffentlichung"
          description="Ohne diese Freigabe bleibt der Meta-Entwurf pausiert, unabhängig davon, ob die Launch-QA besteht."
        >
          <ApprovalPanel
            campaignId={id}
            status={publishApproval}
            canDecide={can(user, APPROVAL_PERMISSIONS.PUBLISH)}
            requiredRoleDe={rolesWithPermission(APPROVAL_PERMISSIONS.PUBLISH)
              .map((role) => ROLE_LABELS_DE[role])
              .join(', ')}
            decide={decidePublishApproval}
            advance={
              option
                ? {
                    labelDe: option.labelDe,
                    to: option.to,
                    run: option.publishing ? publishCampaign : advanceCampaign,
                    permitted: can(user, option.publishing ? 'campaign.publish' : 'campaign.edit'),
                    blockedReasonDe,
                  }
                : undefined
            }
          />
        </Section>
      ) : null}
    </div>
  );
}
