import { expect, test } from '../../fixtures/test';
import { FormDriver } from '../../fixtures/form';
import { ARMS, FUNNEL_SLUG, HYBRID_SLUG, LANDING_SLUG } from '../../fixtures/ids';
import { launchUrlFor } from '../../fixtures/launch-token';
import { FUNNEL_URL } from '../../fixtures/config';

/**
 * Arm assignment, and what must never move once it has happened.
 *
 * The arm is a pure function of the visitor id and the experiment's salt, so
 * "stable" here means the strong version: the same visitor gets the same arm
 * across reloads, across a new tab, and after walking half the form — with no
 * flash of the control before the variant, because assignment happens on the
 * server before the first byte.
 */

test.describe('Experimentzuweisung', () => {
  test('hält den Arm über Reloads, Tabs und Formularschritte hinweg', async ({
    visitorContext,
    visitor,
    form,
  }) => {
    const assigned = await form.open();

    for (let reload = 0; reload < 3; reload += 1) {
      await visitor.reload();
      const seen = await form.arm();
      expect(seen.armId, 'Der Besucher hat den Arm zwischen zwei Aufrufen gewechselt.').toBe(
        assigned.armId,
      );
    }

    /* A second tab in the same browser is the same visitor. */
    const second = await visitorContext.newPage();
    const secondForm = new FormDriver(second);
    await secondForm.open();
    expect((await secondForm.arm()).armId).toBe(assigned.armId);
    await second.close();

    /* And the arm survives the walk itself: the served form version is frozen
       for this visit, so the intro copy is still the arm's when we come back. */
    await form.start();
    await visitor.goto(`/f/${FUNNEL_SLUG}`);
    expect((await form.arm()).armId).toBe(assigned.armId);
  });

  test('verteilt über viele Besucher auf beide Arme', async ({ browser }) => {
    /* Not a distribution test — with a hash-based assignment that would be a
       statistics exercise. This asserts only that both arms are actually
       reachable, which is what a broken salt or a mis-wired allocation breaks. */
    const seen = new Set<string>();
    for (let visitorIndex = 0; visitorIndex < 12 && seen.size < ARMS.length; visitorIndex += 1) {
      const context = await browser.newContext({ baseURL: FUNNEL_URL, locale: 'de-DE' });
      const page = await context.newPage();
      const driver = new FormDriver(page);
      seen.add((await driver.open()).armId);
      await context.close();
    }
    expect(seen.size, `Es wurde nur ein Arm ausgeliefert: ${[...seen].join(', ')}`).toBe(
      ARMS.length,
    );
  });

  test('liefert nur veröffentlichte Versionen aus', async ({ visitor }) => {
    /* Both published slugs render; the draft version behind the landing page is
       reachable by id only through the preview route, never through a slug. */
    await visitor.goto(`/f/${LANDING_SLUG}`);
    await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(visitor.getByText('ENTWURF — nicht veröffentlicht')).toHaveCount(0);

    /* `.first()` because the hybrid page currently ships two `h1` elements —
       that is asserted as a defect in `accessibility.spec.ts`, not here. */
    await visitor.goto(`/f/${HYBRID_SLUG}`);
    await expect(visitor.getByRole('heading', { level: 1 }).first()).toBeVisible();

    const missing = await visitor.goto('/f/gibt-es-nicht');
    expect(missing?.status()).toBe(404);
  });

  test('nimmt einen signierten Launch-Link an und trägt ihn im Besuch weiter', async ({
    visitorContext,
    visitor,
    form,
  }) => {
    const arm = ARMS[0]!;
    const url = launchUrlFor(
      FUNNEL_SLUG,
      {
        funnel_id: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1001',
        funnel_version_id: arm.funnelVersionId,
        form_version_id: arm.formVersionId,
        experiment_id: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1010',
      },
      { marketing: { utm_source: 'facebook', utm_medium: 'paid', fbclid: 'e2e-click' } },
    );

    await visitor.goto(url);
    await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
    await form.arm();

    /* The token rides on the landing URL only. It is carried forward in a
       first-party HttpOnly cookie so the collector and the submit endpoint —
       which never see that URL — can still resolve trusted ids. */
    const cookies = await visitorContext.cookies(FUNNEL_URL);
    const carried = cookies.find((cookie) => cookie.name === 'am_t');
    expect(carried, 'Der Launch-Token wurde nicht als First-Party-Cookie übernommen.').toBeTruthy();
    expect(carried?.httpOnly).toBe(true);
    expect(carried?.value).toBe(new URL(url).searchParams.get('am_t'));

    /* Identity is first-party and HttpOnly as well; nothing cross-site is set. */
    const names = cookies.map((cookie) => cookie.name);
    expect(names).toContain('am_vid');
    expect(names).toContain('am_sid');
    for (const cookie of cookies) {
      expect(cookie.domain.replace(/^\./, '')).toBe(new URL(FUNNEL_URL).hostname);
    }
  });

  test('trägt keine personenbezogenen Daten in die URL', async ({ visitor, form }) => {
    await form.open();
    await form.walkToContact();
    await form.submit();
    await form.expectAnalysisResult();

    const url = visitor.url();
    for (const secret of ['Katrin', 'Bergmann', 'bergmann-haustechnik', '48431', '987654']) {
      expect(url, `„${secret}" steht in der Adresszeile.`).not.toContain(secret);
    }
  });
});
