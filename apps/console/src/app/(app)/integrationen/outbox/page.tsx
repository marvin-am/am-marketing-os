import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  PageHeader,
} from '@am/ui';
import { OutboxView } from '@/components/integrations/outbox-view';
import { requireUser } from '@/lib/action';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { getOpsPort } from '@/server/ops-fixtures';
import { retryOutboxEventAction } from '../actions';

export const metadata = {
  title: 'Outbox · A&M Marketing OS',
};

/**
 * The transactional outbox and its dead letter (spec §24).
 *
 * Everything that has not reached a provider is visible here with the
 * provider's own error message and its redacted response — so a gap in the
 * numbers always has a name.
 */
export default async function OutboxPage() {
  const user = await requireUser('campaign.read');
  const snapshot = await getOpsPort().loadOutbox();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="/integrationen">Integrationen</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Outbox</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
        title="Outbox und Dead Letter"
        description="Ausstehende, wiederholte und aufgegebene Ereignisse mit ihrem letzten Fehler und der redigierten Antwort des Anbieters."
        meta={
          <span className="text-xs text-muted-foreground">
            Stand: {formatDateTime(snapshot.generatedAt)}
          </span>
        }
      />
      <OutboxView
        snapshot={snapshot}
        canManage={can(user, 'integration.manage')}
        onRetry={retryOutboxEventAction}
      />
    </div>
  );
}
