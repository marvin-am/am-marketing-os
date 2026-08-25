import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { getServerEnv, isEmailAllowed, isProviderConfigured } from '@am/config';
import { type Role, roleSchema } from '@am/domain';
import type { SessionUser } from './permissions';

/**
 * Session resolution.
 *
 * Two paths, and the difference is visible to the user rather than hidden:
 *
 * - **Supabase Auth** when a project is configured. Google OAuth or magic link,
 *   gated by the e-mail allowlist.
 * - **Demo session** when `DEMO_MODE` is on and no Supabase project exists. The
 *   console then runs against fixtures, and the sign-in screen says so
 *   explicitly. This is what lets the whole workflow — and the E2E suite — run
 *   before any credential has been supplied.
 *
 * The demo cookie is HMAC-signed with `TRACKING_SIGNING_SECRET` so it cannot be
 * forged into a different role by editing the browser's cookie jar.
 */

const DEMO_COOKIE = 'am_demo_session';
const DEMO_MAX_AGE_SECONDS = 60 * 60 * 12;

export const DEMO_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

interface DemoSessionPayload {
  email: string;
  name: string;
  roles: Role[];
  exp: number;
}

function signingSecret(): string {
  const secret = getServerEnv().TRACKING_SIGNING_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'TRACKING_SIGNING_SECRET fehlt oder ist zu kurz. Ohne Signaturschlüssel kann keine Sitzung ausgestellt werden.',
    );
  }
  return secret;
}

function sign(value: string): string {
  return createHmac('sha256', signingSecret()).update(value).digest('base64url');
}

export function encodeDemoSession(payload: DemoSessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodeDemoSession(token: string | undefined): DemoSessionPayload | null {
  if (!token) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = sign(body);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.email !== 'string' || typeof candidate.exp !== 'number') return null;
    if (candidate.exp < Math.floor(Date.now() / 1000)) return null;

    const roles = Array.isArray(candidate.roles)
      ? candidate.roles.flatMap((role) => {
          const result = roleSchema.safeParse(role);
          return result.success ? [result.data] : [];
        })
      : [];
    if (roles.length === 0) return null;

    return {
      email: candidate.email,
      name: typeof candidate.name === 'string' ? candidate.name : candidate.email,
      roles,
      exp: candidate.exp,
    };
  } catch {
    return null;
  }
}

export function buildDemoSessionCookie(email: string, name: string, roles: Role[]) {
  const token = encodeDemoSession({
    email,
    name,
    roles,
    exp: Math.floor(Date.now() / 1000) + DEMO_MAX_AGE_SECONDS,
  });
  return {
    name: DEMO_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: DEMO_MAX_AGE_SECONDS,
    },
  };
}

export const DEMO_SESSION_COOKIE_NAME = DEMO_COOKIE;

/** True when the console is running without a configured Supabase project. */
export function isDemoAuth(): boolean {
  return getServerEnv().DEMO_MODE && !isProviderConfigured('SUPABASE');
}

/**
 * Resolves the current user, or `null`. Never throws — an unauthenticated
 * request is a normal state that the layout redirects on.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();

  if (isDemoAuth()) {
    const payload = decodeDemoSession(store.get(DEMO_COOKIE)?.value);
    if (!payload) return null;
    return {
      id: demoUserId(payload.email),
      email: payload.email,
      displayName: payload.name,
      roles: payload.roles,
      workspaceId: DEMO_WORKSPACE_ID,
    };
  }

  const { createServerSupabaseClient } = await import('./supabase');
  const supabase = await createServerSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;

  // The allowlist is re-checked on every request, not only at sign-in, so that
  // removing a domain takes effect immediately rather than at token expiry.
  if (!isEmailAllowed(data.user.email)) return null;

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id, roles')
    .eq('profile_id', data.user.id)
    .maybeSingle();

  if (!membership) return null;

  const roles = Array.isArray(membership.roles)
    ? membership.roles.flatMap((role: unknown) => {
        const parsed = roleSchema.safeParse(role);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

  return {
    id: data.user.id,
    email: data.user.email,
    displayName:
      (data.user.user_metadata?.full_name as string | undefined) ?? data.user.email,
    roles: roles.length > 0 ? roles : ['VIEWER'],
    workspaceId: membership.workspace_id as string,
  };
}

/** Deterministic pseudo-uuid so demo sessions have a stable actor id in audits. */
function demoUserId(email: string): string {
  const hash = createHmac('sha256', 'demo-user').update(email).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}
