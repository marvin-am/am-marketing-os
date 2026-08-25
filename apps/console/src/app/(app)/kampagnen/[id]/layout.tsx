import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  LoadingState,
} from '@am/ui';
import { CampaignRoomHeader } from '@/components/campaign/campaign-room-header';
import { CampaignTabs } from '@/components/campaign/campaign-tabs';
import { requireUser } from '@/lib/action';
import { getCampaignPort } from '@/server/campaign-fixtures';

export const dynamic = 'force-dynamic';

/**
 * The Campaign Room shell.
 *
 * The header is rendered here rather than per tab, so it is genuinely
 * persistent: switching tabs never loses the status, the approvals or the next
 * required action.
 */
export default async function CampaignRoomLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireUser('campaign.read');
  const { id } = await params;
  const header = await getCampaignPort().getHeader(id, false);
  if (!header) notFound();

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/kampagnen">Kampagnen</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{header.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <Suspense
        fallback={<LoadingState label="Kampagnenkopf wird geladen …" variant="tiles" rows={4} />}
      >
        <CampaignRoomHeader header={header} />
      </Suspense>

      <CampaignTabs campaignId={header.id} />

      <div className="min-w-0">{children}</div>
    </div>
  );
}
