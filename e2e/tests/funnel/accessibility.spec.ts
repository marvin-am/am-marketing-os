import { expect, test } from '../../fixtures/test';
import { CONTACT_STEP_TITLE, LOCATION_STEP_TITLE, QUALIFIED_QUESTIONS } from '../../fixtures/form';
import { HYBRID_SLUG } from '../../fixtures/ids';
import {
  expectEveryInputHasAccessibleName,
  expectSingleH1,
  focusedFieldId,
} from '../../fixtures/layout';

/**
 * Accessibility of the funnel, asserted rather than smoke-tested.
 *
 * Four properties, each of which fails silently in a screenshot test: every
 * control is named, an error is wired to the field it belongs to, consent is
 * never pre-ticked, and the document has exactly one `h1`.
 */

test.describe('Barrierefreiheit der Formularstrecke', () => {
  test('gibt jedem Feld einen zugänglichen Namen — auf jedem Schritt', async ({
    visitor,
    form,
  }) => {
    await form.open();
    await expectSingleH1(visitor);

    await form.start();
    for (const step of QUALIFIED_QUESTIONS) {
      await form.expectOnStep(step.title);
      await expectSingleH1(visitor);
      await expectEveryInputHasAccessibleName(visitor);
      await form.answer(step);
      await form.next();
    }

    await form.expectOnStep(LOCATION_STEP_TITLE);
    await expectSingleH1(visitor);
    await expectEveryInputHasAccessibleName(visitor);
    await form.fillPostcode();
    await form.next();

    await form.expectOnStep(CONTACT_STEP_TITLE);
    await expectSingleH1(visitor);
    await expectEveryInputHasAccessibleName(visitor);

    await form.fillContact();
    await form.submit();
    await form.expectAnalysisResult();
    await expectSingleH1(visitor);
  });

  test('benennt jede Antwortoption mit ihrem eigenen Text', async ({ visitor, form }) => {
    await form.open();
    await form.start();

    /*
     * DEFECT — see the report.
     *
     * `apps/funnels/src/components/form-field.tsx` renders a field-level
     * `<label htmlFor={fieldDomId(field.fieldId)}>` for choice fields *and*
     * gives that same id to the first option's input. The first radio therefore
     * announces as "Welche Rolle haben Sie im Betrieb? Geschäftsführung oder
     * Inhaber:in" while its siblings announce as "Marketing", and clicking the
     * question text selects the first option. The `<legend class="sr-only">`
     * inside the fieldset already names the group, so the extra label buys
     * nothing.
     */
    const options = ['Geschäftsführung oder Inhaber:in', 'Marketing', 'Vertrieb', 'Andere Rolle'];
    for (const label of options) {
      await expect(
        visitor.getByRole('radio', { name: label }),
        `Option „${label}" trägt einen anderen zugänglichen Namen als ihren eigenen.`,
      ).toHaveAccessibleName(label);
    }

    /* The same cause, from the visitor's side: clicking the question must not
       answer it. */
    await expect(visitor.getByRole('radio').first()).not.toBeChecked();
    await visitor.locator(`label[for="feld-rolle"]`).click();
    await expect(
      visitor.getByRole('radio').first(),
      'Ein Klick auf den Fragetext hat die erste Antwort ausgewählt.',
    ).not.toBeChecked();
  });

  test('verdrahtet die Fehlermeldung mit dem Feld und setzt aria-invalid', async ({
    visitor,
    form,
  }) => {
    await form.open();
    await form.start();
    await form.answerQuestions();
    await form.fillPostcode('abc');
    await form.next();

    const field = visitor.getByLabel('Postleitzahl');
    const error = visitor.locator('#feld-plz-fehler');

    await expect(error).toBeVisible();
    await expect(error).toHaveRole('alert');
    await expect(field).toHaveAttribute('aria-invalid', 'true');

    const describedBy = (await field.getAttribute('aria-describedby')) ?? '';
    expect(
      describedBy.split(/\s+/),
      'aria-describedby verweist nicht auf die Fehlermeldung.',
    ).toContain('feld-plz-fehler');
    expect(
      describedBy.split(/\s+/),
      'aria-describedby verliert den Hilfetext, sobald ein Fehler dazukommt.',
    ).toContain('feld-plz-hilfe');

    /* The invalid field takes focus so a keyboard user lands on the problem. */
    expect(await focusedFieldId(visitor)).toBe('plz');

    /* Correcting it clears both the message and the invalid state. */
    await form.fillPostcode();
    await expect(error).toHaveCount(0);
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('hakt die Einwilligung niemals vor', async ({ visitor, form }) => {
    await form.open();
    await form.start();
    await form.answerQuestions();
    await form.fillPostcode();
    await form.next();
    await form.expectOnStep(CONTACT_STEP_TITLE);

    const consent = form.consentCheckbox();
    await expect(consent).toBeVisible();
    await expect(consent).toHaveAttribute('type', 'checkbox');
    await expect(consent, 'Die Einwilligung war vorausgewählt.').not.toBeChecked();

    /* And a restored draft must not invent it either: the visitor never ticked
       it, so coming back to the step must not find it ticked. */
    await visitor.reload();
    await form.expectOnStep(CONTACT_STEP_TITLE);
    await expect(
      form.consentCheckbox(),
      'Nach dem Wiederherstellen war die Einwilligung gesetzt.',
    ).not.toBeChecked();
  });

  test('hat auch auf der Hybrid-Seite genau eine h1', async ({ visitor }) => {
    /*
     * DEFECT — see the report.
     *
     * `apps/funnels/src/components/funnel-form.tsx` renders the current step's
     * title as an `<h1>`. That is right for a standalone form page, where the
     * step *is* the document. On a hybrid funnel the page already has its own
     * `<h1>` in the hero, so `/f/potenzialanalyse-kurz` ships two — and the
     * document outline no longer says what the page is about.
     */
    await visitor.goto(`/f/${HYBRID_SLUG}`);
    await expect(visitor.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectSingleH1(visitor);
  });

  test('hat auf jedem Bildschirm genau eine h1', async ({ visitor, form }) => {
    await form.open();
    await expectSingleH1(visitor);

    /* Also on a terminal screen, where a second headline is easy to slip in. */
    await form.walkToDisqualification();
    await form.expectNotAFitResult();
    await expectSingleH1(visitor);
  });
});
