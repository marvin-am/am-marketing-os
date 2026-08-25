import { redirect } from 'next/navigation';

/** The Campaign Room has no index of its own — it opens on the strategy tab. */
export default async function CampaignRoomIndex({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/kampagnen/${id}/strategie`);
}
