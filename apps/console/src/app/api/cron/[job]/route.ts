import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getServerEnv } from '@am/config';
import { JOB_NAMES, getJob, runJob, type JobName } from '@am/jobs';
import { logger } from '@am/observability';
import { buildJobPorts, buildJobProviders, jobEnvironment } from '@/server/job-runtime';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Cron entry point. One handler for every scheduled job, resolved by name from
 * `@am/jobs`'s registry — so `vercel.json` and the code cannot drift into
 * naming different things.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without a configured
 * secret the endpoint refuses outright rather than running unauthenticated: an
 * open endpoint that dispatches the outbox is an open endpoint that can be made
 * to hammer a provider.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ job: string }> }) {
  const { job } = await context.params;

  if (!isJobName(job)) {
    return NextResponse.json(
      { ok: false, errorDe: `Unbekannter Job: ${job}` },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const authorized = isAuthorized(request);
  if (!authorized.ok) {
    logger.warn('cron_unauthorized', { job });
    return NextResponse.json(
      { ok: false, errorDe: authorized.reasonDe },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const definition = getJob(job);
  const { environment, flags, workspaceId } = jobEnvironment();

  // Finish a little before the platform's own timeout so the job can stop
  // cleanly between batches and report a partial result.
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), (maxDuration - 20) * 1000);

  try {
    const [ports, providers] = await Promise.all([buildJobPorts(), buildJobProviders()]);

    const result = await runJob({
      definition,
      context: {
        now: new Date(),
        workspaceId,
        environment,
        flags,
        signal: controller.signal,
        ports,
        providers,
      },
    });

    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  } finally {
    clearTimeout(budget);
  }
}

function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

function isAuthorized(request: NextRequest): { ok: true } | { ok: false; reasonDe: string } {
  const secret = getServerEnv().CRON_SECRET;
  if (!secret) {
    return {
      ok: false,
      reasonDe:
        'CRON_SECRET ist nicht gesetzt. Der Endpunkt wird ohne konfiguriertes Geheimnis nicht ausgeführt.',
    };
  }

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reasonDe: 'Nicht autorisiert.' };
  }
  return { ok: true };
}
