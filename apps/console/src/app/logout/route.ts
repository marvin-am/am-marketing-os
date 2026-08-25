import { NextResponse } from 'next/server';
import { getPublicEnv } from '@am/config';
import { DEMO_SESSION_COOKIE_NAME, isDemoAuth } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Sign-out. GET rather than a form post because it is linked from the account
 * menu; it only clears the caller's own session, so there is nothing here for a
 * forged cross-site request to achieve.
 */
export async function GET() {
  const loginUrl = new URL('/login', getPublicEnv().NEXT_PUBLIC_CONSOLE_URL);
  const response = NextResponse.redirect(loginUrl);

  if (isDemoAuth()) {
    response.cookies.set(DEMO_SESSION_COOKIE_NAME, '', { path: '/', maxAge: 0 });
    return response;
  }

  const { createServerSupabaseClient } = await import('@/lib/supabase');
  const supabase = await createServerSupabaseClient();
  await supabase?.auth.signOut();
  return response;
}
