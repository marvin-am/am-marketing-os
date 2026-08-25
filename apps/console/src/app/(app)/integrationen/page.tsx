import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle, Badge, PageHeader, Section } from '@am/ui';
import { ProviderCard } from '@/components/integrations/provider-card';
import { requireUser } from '@/lib/action';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { getOpsPort } from '@/server/ops-fixtures';
import { recheckProviderAction, retryProviderFailedAction } from './actions';

export const metadata = {
  title: 'Integrationen · A&M Marketing OS',
};

/**
 * The integrations overview: one card per provider with its connection state,
 * every health probe, the last sync and the number of stuck events.
 *
 * The page never claims a connection that does not exist. In fixture mode each
 * card says so in its own words, and a probe that is merely waiting on a
 * credential is presented as waiting — not as a failure.
 */
export default async function IntegrationenPage() {
  const user = await requireUser('campaign.read');
  const snapshot = await getOpsPort().loadIntegrations();
  const canManage = can(user, 'integration.manage');

  const writesOff = !snapshot.flags.externalWritesEnabled;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Integrationen"
        description="Meta, HubSpot, OpenAI und Supabase — Verbindungsstatus, Prüfungen und fehlgeschlagene Ereignisse."
        meta={
          <span className="text-xs text-muted-foreground">
            Stand: {formatDateTime(snapshot.generatedAt)}
          </span>
        }
        actions={
          <Link
            href="/integrationen/outbox"
            className="text-sm font-medium text-brand underline-offset-4 hover:underline"
          >
            Outbox und Dead Letter
          </Link>
        }
      />

      {writesOff ? (
        <Alert tone="info">
          <AlertTitle>Externe Schreibzugriffe sind deaktiviert.</AlertTitle>
          <AlertDescription>
            Jede Aktion, die etwas an einen Anbieter senden würde, endet als Dry-Run und zeigt
            genau, was gesendet worden wäre. Die Schalter liegen in der Umgebung und werden unter{' '}
            <Link href="/einstellungen?tab=flags#feature-flags" className="underline underline-offset-4">
              Einstellungen
            </Link>{' '}
            angezeigt.
          </AlertDescription>
        </Alert>
      ) : null}

      <Section
        heading="Anbieter"
        description="Ein Prüfergebnis „Wartet auf externen Input“ bedeutet, dass eine Angabe fehlt, die nur von außen kommen kann — es ist kein Fehler."
        meta={<Badge tone="neutral">{snapshot.providers.length}</Badge>}
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {snapshot.providers.map((provider) => (
            <ProviderCard
              key={provider.provider}
              data={provider}
              canManage={canManage}
              onRecheck={recheckProviderAction}
              onRetryFailed={retryProviderFailedAction}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}
