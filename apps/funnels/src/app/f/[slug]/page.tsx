import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPublishedFunnelBySlug, resolveServedFunnel } from '@/server/published';
import { pageRequest } from '@/server/request';
import { prepareFunnel } from '@/server/render';
import { FunnelView } from '@/components/funnel-view';

/**
 * The live funnel.
 *
 * This is the page a visitor lands on after clicking a Meta ad, and the only
 * part of the system exposed to the open internet. Three properties are load
 * bearing:
 *
 * - **Only a published version is ever served.** `getPublishedFunnelBySlug`
 *   refuses anything that is not `PUBLISHED`, so a draft cannot appear on a live
 *   slug no matter what is saved in the builder (AGENTS.md rule 6).
 * - **It renders on the server.** The visitor gets HTML on the first byte;
 *   arm assignment has already happened, so there is no flash of the control
 *   before the variant.
 * - **Nothing is indexed by default.** A paid funnel page competing with the
 *   main site in search is a bug, so `seo.noindex` is honoured and defaults on.
 *
 * The route is dynamic because identity comes from cookies. The expensive part —
 * the published spec — is cached in `published.ts`, where it is legitimately
 * immutable.
 */

export const dynamic = 'force-dynamic';

interface FunnelPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: FunnelPageProps): Promise<Metadata> {
  const { slug } = await params;
  const version = await getPublishedFunnelBySlug(slug);
  if (!version) return { title: 'Seite nicht gefunden', robots: { index: false, follow: false } };

  const spec = version.spec;
  if (spec.kind === 'MULTI_STEP_FORM') {
    return {
      title: spec.title,
      description: spec.intro.subline ?? undefined,
      robots: { index: false, follow: false },
    };
  }

  return {
    title: spec.seo.metaTitle,
    description: spec.seo.metaDescription,
    robots: { index: !spec.seo.noindex, follow: !spec.seo.noindex },
    alternates: spec.seo.canonicalPath ? { canonical: spec.seo.canonicalPath } : undefined,
  };
}

export default async function FunnelPage({ params, searchParams }: FunnelPageProps) {
  const { slug } = await params;
  const query = await searchParams;

  const { context } = await pageRequest(`/f/${slug}`, query);
  const served = await resolveServedFunnel(slug, context.visitorId);
  if (!served) notFound();

  const prepared = await prepareFunnel(served.version, context, served.assignment);

  return (
    <FunnelView
      version={prepared.version}
      formSpec={prepared.formSpec}
      formTargets={prepared.formTargets}
      formInstanceId={prepared.formInstanceId}
      trackerContext={prepared.trackerContext}
      experiment={prepared.experiment}
      redirectAllowlist={prepared.redirectAllowlist}
    />
  );
}
