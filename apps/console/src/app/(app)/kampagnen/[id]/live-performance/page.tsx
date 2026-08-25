import { notFound } from 'next/navigation';
import { PerformancePanel } from '@/components/campaign/performance-panel';
import { requireUser } from '@/lib/action';
import { getCampaignPort } from '@/server/campaign-fixtures';

export const dynamic = 'force-dynamic';

export default async function LivePerformancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser('campaign.read');
  const { id } = await params;
  const view = await getCampaignPort().getLivePerformance(id);
  if (!view) notFound();
  return <PerformancePanel view={view} />;
}
