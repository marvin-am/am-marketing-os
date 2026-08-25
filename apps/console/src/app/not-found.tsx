import Link from 'next/link';
import { Button, EmptyState } from '@am/ui';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        title="Diese Seite existiert nicht."
        description="Der Link ist vermutlich veraltet oder der Datensatz wurde archiviert."
        action={
          <Button asChild>
            <Link href="/heute">Zur Übersicht</Link>
          </Button>
        }
      />
    </div>
  );
}
