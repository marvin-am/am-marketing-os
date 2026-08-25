import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fixtureBuilderPort } from '@/components/builders/fixture-port';
import type { BuilderPort } from '@/components/builders/port';
import { requireUser } from '@/lib/action';
import { PageBuilderScreen } from './page-builder-screen';

/**
 * `/builder/page/<funnelVersionId>` — the landing page and hybrid funnel builder.
 *
 * One route for both document kinds: a hybrid is a landing page plus a form
 * reference, and splitting them into two routes would only duplicate the block
 * editing that makes up nine tenths of the work.
 */
const port: BuilderPort = fixtureBuilderPort;

export const metadata: Metadata = { title: 'Seiten-Builder' };

export default async function PageBuilderPage({
  params,
}: {
  params: Promise<{ funnelVersionId: string }>;
}) {
  await requireUser('funnel.edit');
  const { funnelVersionId } = await params;

  const record = await port.loadPageVersion(funnelVersionId);
  if (!record) notFound();

  const [versions, availableForms] = await Promise.all([
    port.listPageVersions(funnelVersionId),
    port.listPublishedForms(),
  ]);

  return (
    <PageBuilderScreen
      versionId={funnelVersionId}
      spec={record.spec}
      version={record.version}
      published={record.published}
      versions={versions}
      availableForms={availableForms}
    />
  );
}
