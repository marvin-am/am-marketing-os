'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getPublicEnv, getServerEnv, isEmailAllowed } from '@am/config';
import { type Role, roleSchema } from '@am/domain';
import { logger } from '@am/observability';
import { buildDemoSessionCookie, isDemoAuth } from '@/lib/session';

export interface LoginFormState {
  error?: string;
  notice?: string;
}

/**
 * Demo sign-in. Only reachable while `DEMO_MODE` is on and no Supabase project
 * is configured — the form itself says so, so nobody can mistake it for real
 * authentication.
 */
export async function signInDemo(
  _prev: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  if (!isDemoAuth()) {
    return { error: 'Die Demo-Anmeldung ist deaktiviert, weil ein Supabase-Projekt konfiguriert ist.' };
  }

  const email = String(formData.get('email') ?? '').trim();
  const roleValues = formData.getAll('roles').map(String);

  if (!email.includes('@')) {
    return { error: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.' };
  }

  const roles: Role[] = roleValues.flatMap((value) => {
    const parsed = roleSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });

  if (roles.length === 0) {
    return { error: 'Bitte wählen Sie mindestens eine Rolle.' };
  }

  const name = email.split('@')[0]?.replace(/[._-]+/g, ' ') ?? email;
  const cookie = buildDemoSessionCookie(email, titleCase(name), roles);
  const store = await cookies();
  store.set(cookie.name, cookie.value, cookie.options);

  logger.info('demo_sign_in', { roles });
  redirect('/heute');
}

/**
 * Supabase magic link. The allowlist is checked before the mail is requested so
 * an address outside it never receives a link at all.
 */
export async function signInWithMagicLink(
  _prev: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email.includes('@')) {
    return { error: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.' };
  }
  if (!isEmailAllowed(email)) {
    return { error: 'Diese E-Mail-Adresse ist für den Zugang nicht freigegeben.' };
  }

  const { createServerSupabaseClient } = await import('@/lib/supabase');
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { error: 'Es ist kein Supabase-Projekt konfiguriert. Die Anmeldung ist nicht möglich.' };
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${getPublicEnv().NEXT_PUBLIC_CONSOLE_URL}/auth/callback` },
  });

  if (error) {
    logger.warn('magic_link_failed', { reason: error.message });
    return { error: 'Der Anmeldelink konnte nicht versendet werden. Bitte versuchen Sie es erneut.' };
  }

  return { notice: `Wir haben Ihnen einen Anmeldelink an ${email} gesendet.` };
}

/** Google OAuth. Returns the provider URL for the client to follow. */
export async function signInWithGoogle(): Promise<LoginFormState> {
  const { createServerSupabaseClient } = await import('@/lib/supabase');
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { error: 'Es ist kein Supabase-Projekt konfiguriert. Die Anmeldung ist nicht möglich.' };
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${getPublicEnv().NEXT_PUBLIC_CONSOLE_URL}/auth/callback`,
      queryParams: { prompt: 'select_account' },
    },
  });

  if (error || !data.url) {
    logger.warn('google_oauth_failed', { reason: error?.message ?? 'no url' });
    return { error: 'Die Anmeldung über Google ist derzeit nicht möglich.' };
  }

  redirect(data.url);
}

/** Which sign-in methods this deployment actually offers. */
export async function getAuthCapabilities(): Promise<{
  demo: boolean;
  supabase: boolean;
  allowlistHint: string | null;
}> {
  const demo = isDemoAuth();
  const env = getServerEnv();
  const allowlist = env.AUTH_ALLOWLIST;
  return {
    demo,
    supabase: !demo,
    allowlistHint: allowlist.length > 0 ? allowlist.join(', ') : null,
  };
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
