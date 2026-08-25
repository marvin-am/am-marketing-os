import { notFound } from 'next/navigation';
import { VersionHistory } from '@/components/campaign/version-history';
import { requireUser } from '@/lib/action';
import { getCampaignPort } from '@/server/campaign-fixtures';

export const dynamic = 'force-dynamic';

export default async function VersionenPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser('audit.read');
  const { id } = await params;
  const view = await getCampaignPort().getHistory(id);
  if (!view) notFound();
  return <VersionHistory view={view} />;
}
