import { notFound } from 'next/navigation';
import { CrmPanel } from '@/components/campaign/crm-panel';
import { requireUser } from '@/lib/action';
import { can } from '@/lib/permissions';
import { getCampaignPort } from '@/server/campaign-fixtures';
import { retryLeadSync } from '../actions';

export const dynamic = 'force-dynamic';

export default async function LeadsSalesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser('campaign.read');
  const { id } = await params;
  const view = await getCampaignPort().getLeadsAndSales(id);
  if (!view) notFound();
  return (
    <CrmPanel view={view} canRetry={can(user, 'crm.mapping.manage')} retry={retryLeadSync} />
  );
}
