import { LearningList } from '@/components/campaign/learning-list';
import { requireUser } from '@/lib/action';
import { getCampaignPort } from '@/server/campaign-fixtures';

export const dynamic = 'force-dynamic';

export default async function LearningsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser('campaign.read');
  const { id } = await params;
  const cards = await getCampaignPort().getLearnings(id);
  return <LearningList cards={cards} />;
}
