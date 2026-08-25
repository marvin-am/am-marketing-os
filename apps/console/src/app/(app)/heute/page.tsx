import { PageHeader } from '@am/ui';
import { TodayBoard } from '@/components/today/today-board';
import { requireUser } from '@/lib/action';
import { formatDateTime } from '@/lib/format';
import { getOpsPort } from '@/server/ops-fixtures';

export const metadata = {
  title: 'Heute · A&M Marketing OS',
};

/**
 * The daily start page (spec §8).
 *
 * Everything on it is a link to the place where the thing is actually resolved;
 * nothing is decided here. The order is deliberate and lives in
 * `components/today/today-order.ts`.
 */
export default async function HeutePage() {
  await requireUser('campaign.read');
  const today = await getOpsPort().loadToday();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Heute"
        description="Was heute ansteht — Fehler zuerst, dann Freigaben, dann Empfehlungen."
        meta={
          <span className="text-xs text-muted-foreground">
            Stand: {formatDateTime(today.generatedAt)}
          </span>
        }
      />
      <TodayBoard
        generatedAt={today.generatedAt}
        activeCampaigns={today.activeCampaigns}
        items={today.items}
      />
    </div>
  );
}
