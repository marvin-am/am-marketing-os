import { expect, test } from '../../fixtures/test';
import { CONSOLE_URL, OPERATOR_EMAIL } from '../../fixtures/config';
import { demoSessionToken } from '../../fixtures/session';

/**
 * Sign-in, exercised through the real form exactly once.
 *
 * Every other console spec mints the session cookie directly, which is why this
 * file has to prove that the cookie those specs mint is the same one the sign-in
 * screen issues — and that the screen is honest about not being real
 * authentication.
 */

test.describe('Anmeldung', () => {
  test('schickt eine unangemeldete Anfrage auf den Anmeldebildschirm', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: CONSOLE_URL, locale: 'de-DE' });
    const page = await context.newPage();

    await page.goto('/heute');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Demo-Anmeldung' })).toBeVisible();
    /* The screen says plainly what it is; nothing here may look like real auth. */
    await expect(page.getByText('Dies ist keine echte Authentifizierung.')).toBeVisible();

    await context.close();
  });

  test('meldet über das Formular an und landet auf „Heute"', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: CONSOLE_URL, locale: 'de-DE' });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByLabel('E-Mail-Adresse').fill(OPERATOR_EMAIL);

    /* Roles are chosen deliberately: this is an acceptance aid, not a login. */
    await page.getByRole('checkbox', { name: 'Marketing Lead' }).check();
    await page.getByRole('checkbox', { name: 'RevOps' }).check();
    await page.getByRole('button', { name: 'Anmelden' }).click();

    await expect(page).toHaveURL(/\/heute$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    /* `cookies()` without a URL: the cookie is issued with `Secure`, and a
       URL-filtered lookup on plain http would not return it. */
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === 'am_demo_session');
    expect(session, 'Es wurde keine Sitzung ausgestellt.').toBeTruthy();
    expect(session?.httpOnly, 'Die Sitzung ist per JavaScript lesbar.').toBe(true);
    expect(session?.secure).toBe(true);
    /* Signed, so the role list cannot be edited in the cookie jar. */
    expect(session?.value.split('.')).toHaveLength(2);

    await page.goto('/logout');
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/kampagnen');
    await expect(page).toHaveURL(/\/login$/);

    await context.close();
  });

  test('lehnt eine manipulierte Sitzung ab', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: CONSOLE_URL, locale: 'de-DE' });

    /* A payload that claims ADMIN, re-encoded but signed with the wrong key. */
    const [body] = demoSessionToken({ roles: ['ADMIN'] }).split('.');
    await context.addCookies([
      {
        name: 'am_demo_session',
        value: `${body}.gefaelschte-signatur`,
        domain: new URL(CONSOLE_URL).hostname,
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);

    const page = await context.newPage();
    await page.goto('/einstellungen');
    await expect(page, 'Eine gefälschte Signatur wurde akzeptiert.').toHaveURL(/\/login$/);

    await context.close();
  });

  test('zeigt Demo-Modus und deaktivierte Schreibzugriffe dauerhaft an', async ({ operator }) => {
    await operator.goto('/heute');

    /* The safety state is permanent, not buried in settings: nobody looking at
       this screen may be unsure whether an action can reach the real account. */
    await expect(operator.getByText('Demo-Modus', { exact: true })).toBeVisible();
    await expect(operator.getByText('Externe Schreibzugriffe aus')).toBeVisible();
    await expect(operator.getByText('Externe Schreibzugriffe AKTIV')).toHaveCount(0);

    await operator.getByRole('button', { name: 'Konto und Rollen' }).click();
    await expect(operator.getByText(OPERATOR_EMAIL)).toBeVisible();
    await expect(operator.getByText('Marketing Lead')).toBeVisible();
  });
});
