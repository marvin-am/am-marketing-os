import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fixtureBuilderPort } from '@/components/builders/fixture-port';
import type { BuilderPort } from '@/components/builders/port';
import { requireUser } from '@/lib/action';
import { FormBuilderScreen } from './form-builder-screen';

/**
 * `/builder/form/<formVersionId>` — the multi-step form builder.
 *
 * Reads through the `BuilderPort`; swap the binding below for the repository
 * implementation once the data layer exists. A missing version is a 404 rather
 * than an empty editor, and a published version opens read-only with the reason
 * stated on screen.
 */
const port: BuilderPort = fixtureBuilderPort;

export const metadata: Metadata = { title: 'Formular-Builder' };

export default async function FormBuilderPage({
  params,
}: {
  params: Promise<{ formVersionId: string }>;
}) {
  await requireUser('funnel.edit');
  const { formVersionId } = await params;

  const record = await port.loadFormVersion(formVersionId);
  if (!record) notFound();

  const [versions, consentTexts] = await Promise.all([
    port.listFormVersions(formVersionId),
    port.listConsentTexts(),
  ]);

  return (
    <FormBuilderScreen
      versionId={formVersionId}
      spec={record.spec}
      version={record.version}
      published={record.published}
      versions={versions}
      consentTexts={consentTexts}
    />
  );
}
