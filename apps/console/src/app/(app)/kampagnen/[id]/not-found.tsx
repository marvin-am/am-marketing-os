import Link from 'next/link';
import { Button, EmptyState } from '@am/ui';
import { SearchX } from 'lucide-react';

export default function CampaignNotFound() {
  return (
    <EmptyState
      icon={<SearchX />}
      title="Diese Kampagne existiert nicht."
      description="Möglicherweise wurde sie archiviert oder der Link ist veraltet. Die Kampagnenübersicht zeigt alle vorhandenen Kampagnen."
      action={
        <Button asChild>
          <Link href="/kampagnen">Zur Kampagnenübersicht</Link>
        </Button>
      }
    />
  );
}
