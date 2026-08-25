import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { CONSOLE_URL, FUNNEL_URL } from './config';
import { FormDriver } from './form';
import { signIn, type ConsoleRole } from './session';

/**
 * The suite's fixtures.
 *
 * Three of them, because the product has three actors:
 *
 * - `operator` — a signed-in console page. The session cookie is minted, not
 *   typed; `tests/console/auth.spec.ts` covers the real sign-in form once.
 * - `visitor` — a **fresh** browser context on the public funnel. Fresh matters:
 *   the experiment arm is a pure function of the visitor id, so reusing a
 *   context would reuse an arm and hide an assignment bug.
 * - `form` — the multi-step form driver bound to that visitor.
 *
 * `operator` and `visitor` are independent contexts on purpose. The journey test
 * needs both at once — an operator in the console and a visitor on the funnel —
 * and sharing cookies between them would let a console session leak into the
 * traffic classification of a public page.
 */

export interface AmFixtures {
  /** Roles the `operator` page is signed in with. Override with `test.use`. */
  roles: ConsoleRole[];
  operatorContext: BrowserContext;
  operator: Page;
  visitorContext: BrowserContext;
  visitor: Page;
  form: FormDriver;
  /** Opens a campaign from the list by its German name and returns its id. */
  openCampaign: (name: string, tab?: string) => Promise<string>;
}

export const test = base.extend<AmFixtures>({
  roles: [['MARKETING_OPERATOR', 'MARKETING_LEAD', 'REVOPS'], { option: true }],

  operatorContext: async ({ browser, roles }, use) => {
    const context = await browser.newContext({ baseURL: CONSOLE_URL, locale: 'de-DE' });
    await signIn(context, { roles });
    await use(context);
    await context.close();
  },

  operator: async ({ operatorContext }, use) => {
    const page = await operatorContext.newPage();
    await use(page);
    await page.close();
  },

  visitorContext: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: FUNNEL_URL, locale: 'de-DE' });
    await use(context);
    await context.close();
  },

  visitor: async ({ visitorContext }, use) => {
    const page = await visitorContext.newPage();
    await use(page);
    await page.close();
  },

  form: async ({ visitor }, use) => {
    await use(new FormDriver(visitor));
  },

  openCampaign: async ({ operator }, use) => {
    await use(async (name: string, tab = 'strategie') => {
      await operator.goto('/kampagnen');
      const link = operator.getByRole('link', { name, exact: true });
      await expect(link, `Kampagne „${name}" steht nicht in der Liste.`).toBeVisible();
      const href = await link.getAttribute('href');
      const id = href?.split('/')[2];
      if (!id) throw new Error(`Kein Kampagnen-Link für „${name}" gefunden (href: ${href}).`);
      await operator.goto(`/kampagnen/${id}/${tab}`);
      return id;
    });
  },
});

export { expect };
export { CONSOLE_URL, FUNNEL_URL } from './config';
