import Link from 'next/link';
import { Button, EmptyState, PageHeader } from '@am/ui';

export default function ExperimentNotFound() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Experiment nicht gefunden" />
      <EmptyState
        title="Dieses Experiment existiert nicht"
        description="Der Link zeigt auf ein Experiment, das es nicht (mehr) gibt. Möglicherweise wurde es verworfen."
        action={
          <Button asChild variant="secondary">
            <Link href="/experimente">Zur Experimentübersicht</Link>
          </Button>
        }
      />
    </div>
  );
}
