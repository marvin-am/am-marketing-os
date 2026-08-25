import { LoadingState } from '@am/ui';

export default function CampaignRoomLoading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingState label="Kampagne wird geladen …" variant="tiles" rows={4} />
      <LoadingState label="Inhalte werden geladen …" rows={5} />
    </div>
  );
}
