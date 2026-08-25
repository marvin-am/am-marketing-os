import { PageHeader } from '@am/ui';
import { LibraryBrowser } from '@/components/library/library-browser';
import { requireUser } from '@/lib/action';
import { formatDateTime } from '@/lib/format';
import { getOpsPort } from '@/server/ops-fixtures';

export const metadata = {
  title: 'Library · A&M Marketing OS',
};

/**
 * The knowledge base every campaign draws on: creatives with their renditions
 * and performance, angles and their versions, offers, claims with their
 * evidence, proof material, guardrails and the historical campaigns — each with
 * the attribution level its numbers actually rest on.
 */
export default async function LibraryPage() {
  await requireUser('campaign.read');
  const snapshot = await getOpsPort().loadLibrary();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Library"
        description="Creatives, Angles, Offers, Claims, Belege, Guardrails und historische Kampagnen — durchsuchbar und mit ihrer Belastbarkeit."
        meta={
          <span className="text-xs text-muted-foreground">
            Stand: {formatDateTime(snapshot.generatedAt)}
          </span>
        }
      />
      <LibraryBrowser snapshot={snapshot} />
    </div>
  );
}
