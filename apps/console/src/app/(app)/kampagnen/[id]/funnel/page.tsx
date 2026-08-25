import { notFound } from 'next/navigation';
import { FunnelList } from '@/components/campaign/funnel-list';
import { requireUser } from '@/lib/action';
import { getCampaignPort } from '@/server/campaign-fixtures';

export const dynamic = 'force-dynamic';

export default async function FunnelPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser('campaign.read');
  const { id } = await params;
  const view = await getCampaignPort().getFunnelOverview(id);
  if (!view) notFound();
  return <FunnelList view={view} />;
}
