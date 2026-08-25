import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  PageHeader,
} from '@am/ui';
import { MetaWizard } from '@/components/integrations/meta-wizard';
import { requireUser } from '@/lib/action';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { getOpsPort } from '@/server/ops-fixtures';
import { recheckProviderAction } from '../actions';

export const metadata = {
  title: 'Meta-Einrichtung · A&M Marketing OS',
};

/** The ten-step Meta setup wizard (spec §21). */
export default async function MetaSetupPage() {
  const user = await requireUser('campaign.read');
  const snapshot = await getOpsPort().loadMetaSetup();

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
                <BreadcrumbPage>Meta</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
        title="Meta einrichten"
        description="Zehn Schritte von der App-Verbindung bis zur abschließenden Gesamtprüfung. Kein Schritt legt etwas an und keiner sendet ein Ereignis."
        meta={
          <span className="text-xs text-muted-foreground">
            Stand: {formatDateTime(snapshot.generatedAt)}
          </span>
        }
      />
      <MetaWizard
        snapshot={snapshot}
        canManage={can(user, 'integration.manage')}
        onRecheck={recheckProviderAction}
      />
    </div>
  );
}
