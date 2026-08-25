import { NextResponse, type NextRequest } from 'next/server';
import { getPublicEnv, isEmailAllowed } from '@am/config';
import { logger } from '@am/observability';
import { createServerSupabaseClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * OAuth / magic-link callback.
 *
 * The allowlist is enforced here as well as at sign-in: a valid Google account
 * outside the allowed domains must not end up with a session just because it
 * completed the provider flow.
 */
export async function GET(request: NextRequest) {
  const consoleUrl = getPublicEnv().NEXT_PUBLIC_CONSOLE_URL;
  const code = request.nextUrl.searchParams.get('code');

  const failure = (reason: string) =>
    NextResponse.redirect(new URL(`/login?fehler=${encodeURIComponent(reason)}`, consoleUrl));

  if (!code) return failure('kein_code');

  const supabase = await createServerSupabaseClient();
  if (!supabase) return failure('nicht_konfiguriert');

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user?.email) {
    logger.warn('auth_callback_failed', { reason: error?.message ?? 'no user' });
    return failure('anmeldung_fehlgeschlagen');
  }

  if (!isEmailAllowed(data.user.email)) {
    await supabase.auth.signOut();
    logger.warn('auth_callback_not_allowlisted', {});
    return failure('nicht_freigegeben');
  }

  return NextResponse.redirect(new URL('/heute', consoleUrl));
}
