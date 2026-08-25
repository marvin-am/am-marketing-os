/**
 * Everything the suite needs to know about the environment it runs against.
 *
 * The values mirror the `demoEnv` block in `playwright.config.ts`. They are
 * repeated here rather than imported because the Playwright *runner* process
 * does not inherit the `webServer` environment — only the two Next servers do —
 * so a fixture that needs the signing secret has to carry it itself.
 */

export const CONSOLE_URL = process.env.E2E_CONSOLE_URL ?? 'http://127.0.0.1:3000';
export const FUNNEL_URL = process.env.E2E_FUNNEL_URL ?? 'http://127.0.0.1:3001';

/** Same key the two servers are started with; see `playwright.config.ts`. */
export const TRACKING_SIGNING_SECRET =
  process.env.TRACKING_SIGNING_SECRET ?? 'e2e-tracking-secret-value-at-least-32-chars';

/** Inside `AUTH_ALLOWLIST` (`@am-beratung.de`). */
export const OPERATOR_EMAIL = 'operator@am-beratung.de';
export const OPERATOR_NAME = 'Operator';

/** Host the browser stores cookies under. Cookies are host-only, so no dot. */
export function hostOf(url: string): string {
  return new URL(url).hostname;
}
