import { NextResponse } from 'next/server';
import { getAppConfig, getFeatureFlags } from '@am/config';

export const dynamic = 'force-dynamic';

/**
 * Liveness probe. Reports the safety flags so an operator (and the E2E harness)
 * can see at a glance whether this deployment is able to write to a provider.
 */
export function GET() {
  const flags = getFeatureFlags();
  const config = getAppConfig();
  return NextResponse.json(
    {
      status: 'ok',
      app: 'funnels',
      environment: config.environment,
      flags,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
