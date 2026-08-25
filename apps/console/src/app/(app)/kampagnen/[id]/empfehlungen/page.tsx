import { RecommendationList } from '@/components/campaign/recommendation-card';
import { requireUser } from '@/lib/action';
import { can } from '@/lib/permissions';
import { getCampaignPort } from '@/server/campaign-fixtures';
import { executeRecommendation } from '../actions';

export const dynamic = 'force-dynamic';

export default async function EmpfehlungenPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser('campaign.read');
  const { id } = await params;
  const views = await getCampaignPort().getRecommendations(id);
  return (
    <RecommendationList
      campaignId={id}
      views={views}
      canExecute={can(user, 'recommendation.execute')}
      execute={executeRecommendation}
    />
  );
}
