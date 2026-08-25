import { notFound } from 'next/navigation';
import { APPROVAL_PERMISSIONS } from '@am/domain';
import { advanceOptionFor, rollbackOptionFor } from '@/components/campaign/advance';
import { ApprovalPanel } from '@/components/campaign/approval-panel';
import { CreativeGrid } from '@/components/campaign/creative-grid';
import { assetGateBlockedReasonDe } from '@/components/campaign/gates';
import { requireUser } from '@/lib/action';
import { can, ROLE_LABELS_DE, rolesWithPermission } from '@/lib/permissions';
import { getCampaignPort } from '@/server/campaign-fixtures';
import { advanceCampaign, decideAssetsApproval, reviewCreative } from '../actions';

export const dynamic = 'force-dynamic';

export default async function CreativesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser('campaign.read');
  const { id } = await params;

  const port = getCampaignPort();
  const [board, header] = await Promise.all([port.getCreativeBoard(id), port.getHeader(id, false)]);
  if (!board || !header) notFound();

  const blockedReasonDe = assetGateBlockedReasonDe(board);
  const option = advanceOptionFor('creatives', header.state);
  const rollback = rollbackOptionFor('creatives', header.state);

  return (
    <CreativeGrid
      board={board}
      canReview={can(user, 'creative.approve')}
      review={reviewCreative}
      approvalSlot={
        <ApprovalPanel
          campaignId={id}
          status={board.approval}
          canDecide={can(user, APPROVAL_PERMISSIONS.ASSETS)}
          requiredRoleDe={rolesWithPermission(APPROVAL_PERMISSIONS.ASSETS)
            .map((role) => ROLE_LABELS_DE[role])
            .join(', ')}
          decide={decideAssetsApproval}
          approvalBlockedReasonDe={blockedReasonDe}
          advance={
            option
              ? {
                  labelDe: option.labelDe,
                  to: option.to,
                  run: advanceCampaign,
                  permitted: can(user, 'campaign.edit'),
                  blockedReasonDe,
                }
              : undefined
          }
          rollback={
            rollback
              ? {
                  labelDe: rollback.labelDe,
                  to: rollback.to,
                  confirmDe: rollback.confirmDe,
                  run: advanceCampaign,
                  permitted: can(user, 'campaign.edit'),
                }
              : undefined
          }
        />
      }
    />
  );
}
