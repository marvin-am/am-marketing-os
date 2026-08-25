import { createHmac } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { CONSOLE_URL, hostOf, OPERATOR_EMAIL, OPERATOR_NAME, TRACKING_SIGNING_SECRET } from './config';

/**
 * The console's demo session, minted directly.
 *
 * `apps/console/src/lib/session.ts` signs `am_demo_session` with an HMAC over a
 * base64url JSON payload, so a test can produce a valid one without driving the
 * sign-in form. That is deliberate: the form is exercised **once**, by
 * `tests/console/auth.spec.ts`, and every other spec starts from an
 * already-authenticated context. Re-signing in per test would add a navigation
 * and a form round-trip to fifty tests to re-prove the same thing.
 *
 * The role set is a parameter because several assertions are *about* roles: a
 * refused budget change names the role that may approve it, and a viewer must
 * not see an execute button at all.
 */

export type ConsoleRole =
  | 'VIEWER'
  | 'MARKETING_OPERATOR'
  | 'CREATIVE_REVIEWER'
  | 'MARKETING_LEAD'
  | 'REVOPS'
  | 'EXECUTIVE'
  | 'ADMIN';

/**
 * The default operator: enough to approve, publish, execute recommendations and
 * manage integrations, and nothing more. Deliberately *not* `ADMIN`, so a
 * missing permission surfaces as a failing test rather than being papered over.
 */
export const DEFAULT_ROLES: ConsoleRole[] = ['MARKETING_OPERATOR', 'MARKETING_LEAD', 'REVOPS'];

const COOKIE_NAME = 'am_demo_session';
const MAX_AGE_SECONDS = 60 * 60 * 12;

function sign(value: string): string {
  return createHmac('sha256', TRACKING_SIGNING_SECRET).update(value).digest('base64url');
}

export interface DemoSessionInput {
  email?: string;
  name?: string;
  roles?: ConsoleRole[];
}

/** The signed cookie value, in the exact format `decodeDemoSession` expects. */
export function demoSessionToken(input: DemoSessionInput = {}): string {
  const payload = {
    email: input.email ?? OPERATOR_EMAIL,
    name: input.name ?? OPERATOR_NAME,
    roles: input.roles ?? DEFAULT_ROLES,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Installs the session cookie on a context so its pages start signed in. */
export async function signIn(
  context: BrowserContext,
  input: DemoSessionInput = {},
): Promise<void> {
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: demoSessionToken(input),
      domain: hostOf(CONSOLE_URL),
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
    },
  ]);
}

export { COOKIE_NAME as DEMO_SESSION_COOKIE_NAME };
