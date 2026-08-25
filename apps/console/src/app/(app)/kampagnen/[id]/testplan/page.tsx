import { notFound } from 'next/navigation';
import { APPROVAL_PERMISSIONS } from '@am/domain';
import { Section } from '@am/ui';
import { advanceOptionFor } from '@/components/campaign/advance';
import { ApprovalPanel } from '@/components/campaign/approval-panel';
import { BudgetPanel } from '@/components/campaign/budget-panel';
import { TestPlanPanel } from '@/components/campaign/test-plan-panel';
import { requireUser } from '@/lib/action';
import { can, ROLE_LABELS_DE, rolesWithPermission } from '@/lib/permissions';
import { getCampaignPort } from '@/server/campaign-fixtures';
import { advanceCampaign, changeDailyBudget, decideTestPlanApproval } from '../actions';

export const dynamic = 'force-dynamic';

export default async function TestplanPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser('campaign.read');
  const { id } = await params;

  const port = getCampaignPort();
  const [view, header] = await Promise.all([port.getTestPlan(id), port.getHeader(id, false)]);
  if (!view || !header) notFound();

  const option = advanceOptionFor('testplan', header.state);

  return (
    <div className="flex flex-col gap-8">
      <Section
        heading="Freigabe des Testplans"
        description="Die Freigabe deckt Hypothese, Metriken, Mindestvolumen, Laufzeitgrenzen, Regeln und das initiale Budget ab."
      >
        <ApprovalPanel
          campaignId={id}
          status={view.approval}
          canDecide={can(user, APPROVAL_PERMISSIONS.TEST_PLAN)}
          requiredRoleDe={rolesWithPermission(APPROVAL_PERMISSIONS.TEST_PLAN)
            .map((role) => ROLE_LABELS_DE[role])
            .join(', ')}
          decide={decideTestPlanApproval}
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
        />
      </Section>

      <TestPlanPanel view={view} />

      <Section
        heading="Tagesbudget ändern"
        description="Budgetänderungen laufen gegen das Rollenlimit. Eine Änderung darüber hinaus wird abgelehnt und nicht gekürzt."
      >
        <BudgetPanel
          campaignId={id}
          currentMinor={header.budget.amountMinor}
          currency={header.budget.currency}
          roles={user.roles}
          canChange={can(user, 'campaign.scale_budget')}
          change={changeDailyBudget}
        />
      </Section>
    </div>
  );
}
