import { notFound } from 'next/navigation';
import { APPROVAL_PERMISSIONS } from '@am/domain';
import { Section } from '@am/ui';
import { advanceOptionFor, rollbackOptionFor } from '@/components/campaign/advance';
import { ApprovalPanel } from '@/components/campaign/approval-panel';
import { StrategyPanel } from '@/components/campaign/strategy-panel';
import { requireUser } from '@/lib/action';
import { can, ROLE_LABELS_DE, rolesWithPermission } from '@/lib/permissions';
import { getCampaignPort } from '@/server/campaign-fixtures';
import { advanceCampaign, decideStrategyApproval } from '../actions';

export const dynamic = 'force-dynamic';

export default async function StrategiePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser('campaign.read');
  const { id } = await params;

  const port = getCampaignPort();
  const [view, header] = await Promise.all([port.getStrategy(id), port.getHeader(id, false)]);
  if (!view || !header) notFound();

  const option = advanceOptionFor('strategie', header.state);
  const rollback = rollbackOptionFor('strategie', header.state);

  return (
    <div className="flex flex-col gap-8">
      <Section
        heading="Freigabe der Strategie"
        description="Die Freigabe gilt für genau diesen Inhaltsstand. Wird Angle, Offer, Kernbotschaft oder ein Claim danach geändert, verfällt sie automatisch."
      >
        <ApprovalPanel
          campaignId={id}
          status={view.approval}
          canDecide={can(user, APPROVAL_PERMISSIONS.STRATEGY)}
          requiredRoleDe={rolesWithPermission(APPROVAL_PERMISSIONS.STRATEGY)
            .map((role) => ROLE_LABELS_DE[role])
            .join(', ')}
          decide={decideStrategyApproval}
          advance={
            option
              ? {
                  labelDe: option.labelDe,
                  to: option.to,
                  run: advanceCampaign,
                  permitted: can(user, 'campaign.edit'),
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
      </Section>

      <StrategyPanel view={view} />
    </div>
  );
}
