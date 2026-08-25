import { PageHeader } from '@am/ui';
import { CampaignFilters } from '@/components/campaign/campaign-filters';
import { CampaignTable } from '@/components/campaign/campaign-table';
import { requireUser } from '@/lib/action';
import { getCampaignPort } from '@/server/campaign-fixtures';
import { buildCampaignHref, isFiltered, parseCampaignQuery, type RawSearchParams } from './query';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Kampagnen · A&M Marketing OS',
};

export default async function KampagnenPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireUser('campaign.read');

  const query = parseCampaignQuery(await searchParams);
  const page = await getCampaignPort().listCampaigns(query);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Kampagnen"
        description="Von der Idee bis zum pausierten Meta-Entwurf. Jede Zeile zeigt, woran die Kampagne gerade hängt und ob die Provider wirklich synchron sind."
      />

      <CampaignFilters query={query} facets={page.facets} total={page.total} />

      <CampaignTable
        page={page}
        filtered={isFiltered(query)}
        buildPageHref={(next) => buildCampaignHref(query, next)}
      />
    </div>
  );
}
