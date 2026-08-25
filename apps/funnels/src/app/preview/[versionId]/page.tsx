import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFunnelVersion } from '@/server/published';
import { pageRequest } from '@/server/request';
import { prepareFunnel } from '@/server/render';
import { FunnelView } from '@/components/funnel-view';
import { PreviewBanner } from '@/components/preview-banner';

/**
 * Internal preview of any funnel version — draft, published or archived.
 *
 * It renders through the *same* `FunnelView` as the live route on purpose: a
 * preview that takes a different code path is a preview that can disagree with
 * what ships, and "it looked right in preview" is how an unreviewed page reaches
 * an ad account.
 *
 * What is deliberately different:
 *
 * - `middleware.ts` sets `am_preview` for this path, so `classifyTraffic`
 *   returns `PREVIEW` and every event, form instance and submission produced
 *   here is excluded from production metrics and from experiment results;
 * - a banner states which version is on screen and that it is not production;
 * - the page is never indexed.
 *
 * There is no authentication here yet because the funnel app has no session
 * concept. The version id is an unguessable UUID and the route is excluded from
 * indexing, which is the honest description of the protection it has — the
 * deployment-level gate belongs with the console's auth and is the lead's to
 * wire.
 */

export const dynamic = 'force-dynamic';

interface PreviewPageProps {
  params: Promise<{ versionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export function generateMetadata(): Metadata {
  return {
    title: 'Vorschau — A&M',
    robots: { index: false, follow: false, nocache: true },
  };
}

export default async function PreviewPage({ params, searchParams }: PreviewPageProps) {
  const { versionId } = await params;
  const query = await searchParams;

  const version = await getFunnelVersion(versionId);
  if (!version) notFound();

  const { context } = await pageRequest(`/preview/${versionId}`, query, true);

  /* Assignment is not applied in preview: the reviewer must see the version
     they asked for, not whichever arm their visitor id happens to fall into. */
  const prepared = await prepareFunnel(version, context, null);

  return (
    <>
      <PreviewBanner
        funnelVersionId={version.funnelVersionId}
        state={version.state}
        publishedAt={version.publishedAt}
      />
      <FunnelView
        version={prepared.version}
        formSpec={prepared.formSpec}
        formTargets={prepared.formTargets}
        formInstanceId={prepared.formInstanceId}
        trackerContext={prepared.trackerContext}
        experiment={prepared.experiment}
        redirectAllowlist={prepared.redirectAllowlist}
      />
    </>
  );
}
