import { expect, test } from '../../fixtures/test';
import { CONTACT_STEP_TITLE, LOCATION_STEP_TITLE, QUALIFIED_QUESTIONS } from '../../fixtures/form';
import {
  expectFocusVisibleWhileTabbing,
  expectNoHorizontalOverflow,
  expectTouchTargets,
  focusedFieldId,
} from '../../fixtures/layout';

/**
 * The funnel on a phone.
 *
 * `playwright.config.ts` pins this project to `devices['iPhone 13']`, whose
 * `defaultBrowserType` is WebKit. Only Chromium is available in this
 * environment, so the browser is pinned here rather than in the config, which
 * this agent does not own — see the report.
 *
 * The three widths are the ones that decide whether a mobile ad click converts:
 * 320 px is the narrowest device still in the wild, 375 px the most common iOS
 * width, and 430 px the largest current iPhone. A layout that survives all
 * three survives the middle as well.
 */

test.use({ browserName: 'chromium', isMobile: true, hasTouch: true });

const WIDTHS = [320, 375, 430] as const;

for (const width of WIDTHS) {
  test.describe(`Breite ${width} px`, () => {
    test.use({ viewport: { width, height: 780 } });

    test('scrollt auf keinem Schritt horizontal', async ({ visitor, form }) => {
      await form.open();
      await expectNoHorizontalOverflow(visitor);

      await form.start();
      for (const [index, step] of QUALIFIED_QUESTIONS.entries()) {
        await form.expectOnStep(step.title);
        await expectNoHorizontalOverflow(visitor);
        await form.answer(step);
        await expectNoHorizontalOverflow(visitor);
        await form.next();
        if (index === QUALIFIED_QUESTIONS.length - 1) break;
      }

      await form.expectOnStep(LOCATION_STEP_TITLE);
      await expectNoHorizontalOverflow(visitor);
      await form.fillPostcode();
      await form.next();

      await form.expectOnStep(CONTACT_STEP_TITLE);
      await expectNoHorizontalOverflow(visitor);
      await form.fillContact();
      await expectNoHorizontalOverflow(visitor);

      await form.submit();
      await form.expectAnalysisResult();
      await expectNoHorizontalOverflow(visitor);
    });

    test('bietet auf jedem Schritt Ziele von mindestens 44 × 44 px', async ({ visitor, form }) => {
      await form.open();
      await expectTouchTargets(visitor);

      await form.start();
      await expectTouchTargets(visitor);

      await form.answer(QUALIFIED_QUESTIONS[0]!);
      await form.next();
      await form.answer(QUALIFIED_QUESTIONS[1]!);
      await form.next();
      await expectTouchTargets(visitor);

      await form.answer(QUALIFIED_QUESTIONS[2]!);
      await form.next();
      await form.answer(QUALIFIED_QUESTIONS[3]!);
      await form.next();
      await form.answer(QUALIFIED_QUESTIONS[4]!);
      await form.next();

      await form.expectOnStep(LOCATION_STEP_TITLE);
      await expectTouchTargets(visitor);
      await form.fillPostcode();
      await form.next();

      await form.expectOnStep(CONTACT_STEP_TITLE);
      await expectTouchTargets(visitor);
    });

    test('markiert den Tastaturfokus sichtbar', async ({ visitor, form }) => {
      await form.open();
      await form.start();
      await expectFocusVisibleWhileTabbing(visitor, 5);
    });
  });
}

test.describe('Verhalten unabhängig von der Breite', () => {
  test.use({ viewport: { width: 375, height: 780 } });

  test('setzt den Fokus auf das erste ungültige Feld', async ({ visitor, form }) => {
    await form.open();
    await form.start();

    /* Nothing answered: the step cannot be completed. */
    await form.next();
    await form.expectOnStep(QUALIFIED_QUESTIONS[0]!.title);
    expect(await focusedFieldId(visitor)).toBe('rolle');
    await expect(visitor.locator('#feld-rolle-fehler')).toHaveText(
      'Bitte füllen Sie dieses Feld aus.',
    );

    await form.answerQuestions();
    await form.expectOnStep(LOCATION_STEP_TITLE);
    await form.next();
    expect(await focusedFieldId(visitor)).toBe('plz');

    await form.fillPostcode();
    await form.next();
    await form.expectOnStep(CONTACT_STEP_TITLE);

    /* Only the surname is filled: the focus must land on the *first* invalid
       field in reading order, not on the last one checked. */
    await visitor.getByLabel('Nachname').fill('Bergmann');
    await form.submit();
    expect(await focusedFieldId(visitor)).toBe('vorname');
  });

  test('behält Antworten beim Zurückgehen', async ({ form }) => {
    await form.open();
    await form.start();
    await form.answer(QUALIFIED_QUESTIONS[0]!);
    await form.next();
    await form.answer(QUALIFIED_QUESTIONS[1]!);
    await form.next();
    await form.answer(QUALIFIED_QUESTIONS[2]!);
    await form.next();

    await form.expectOnStep(QUALIFIED_QUESTIONS[3]!.title);
    await form.back();
    await expect(form.option(QUALIFIED_QUESTIONS[2]!.pick[0]!)).toBeChecked();
    await form.back();
    for (const label of QUALIFIED_QUESTIONS[1]!.pick) {
      await expect(form.option(label, true)).toBeChecked();
    }
    await form.back();
    await expect(form.option(QUALIFIED_QUESTIONS[0]!.pick[0]!)).toBeChecked();
  });

  test('zeigt auf einer verzweigten Strecke keinen erfundenen Prozentwert', async ({
    visitor,
    form,
  }) => {
    await form.open();
    await form.start();

    const progress = visitor.getByRole('progressbar', { name: 'Fortschritt im Formular' });

    /* The budget question can end the form early, so no continuation length is
       knowable from step one — the indicator says which step, and nothing more. */
    await expect(progress).toBeVisible();
    await expect(visitor.getByText('Schritt 1', { exact: true })).toBeVisible();
    await expect(visitor.getByText('Noch wenige Fragen')).toBeVisible();
    await expect(progress).not.toHaveAttribute('aria-valuenow', /.*/);
    await expect(progress).toHaveAttribute('aria-valuetext', 'Schritt 1');
    await expect(visitor.getByText(/\d+\s*%/)).toHaveCount(0);

    await form.answer(QUALIFIED_QUESTIONS[0]!);
    await form.next();
    await expect(visitor.getByText('Schritt 2', { exact: true })).toBeVisible();
    await expect(visitor.getByText(/\d+\s*%/)).toHaveCount(0);

    /* Past the branch the remainder *is* knowable, and only then may a total
       appear. Whatever it says, it must never be a percentage of an unknown. */
    for (const step of QUALIFIED_QUESTIONS.slice(1)) {
      await form.answer(step);
      await form.next();
    }
    await form.expectOnStep(LOCATION_STEP_TITLE);
    const label = await progress.getAttribute('aria-valuetext');
    expect(label).toMatch(/^Schritt \d+( von \d+)?$/);
  });
});
