import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  PageHeader,
} from '@am/ui';
import { HubspotWizard } from '@/components/integrations/hubspot-wizard';
import { requireUser } from '@/lib/action';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { getOpsPort } from '@/server/ops-fixtures';
import {
  applyFixtureMappingAction,
  publishMappingAction,
  runReconciliationTestAction,
  runTestLeadAction,
  runWebhookTestAction,
  saveMappingStepAction,
} from '../actions';

export const metadata = {
  title: 'HubSpot-Mapping · A&M Marketing OS',
};

/** The fifteen-step HubSpot mapping wizard (spec §22). */
export default async function HubspotMappingPage() {
  const user = await requireUser('campaign.read');
  const snapshot = await getOpsPort().loadHubspotMapping();

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
                <BreadcrumbPage>HubSpot-Mapping</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
        title="HubSpot-Mapping"
        description="Fünfzehn Schritte, die beschreiben, wie das Portal des Kunden auf unsere kanonischen Vertriebsereignisse abgebildet wird. Jederzeit unterbrechbar und fortsetzbar."
        meta={
          <span className="text-xs text-muted-foreground">
            Stand: {formatDateTime(snapshot.generatedAt)}
          </span>
        }
      />
      <HubspotWizard
        snapshot={snapshot}
        canManage={can(user, 'crm.mapping.manage')}
        onSaveStep={saveMappingStepAction}
        onApplyFixture={applyFixtureMappingAction}
        onPublish={publishMappingAction}
        onRunTestLead={runTestLeadAction}
        onRunWebhookTest={runWebhookTestAction}
        onRunReconciliationTest={runReconciliationTestAction}
      />
    </div>
  );
}
