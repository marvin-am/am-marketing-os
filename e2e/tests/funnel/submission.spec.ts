import { expect, test } from '../../fixtures/test';
import { FUNNEL_SLUG } from '../../fixtures/ids';
import { SubmitRecorder } from '../../fixtures/network';
import { CONTACT_STEP_TITLE, LOCATION_STEP_TITLE, QUALIFIED_QUESTIONS } from '../../fixtures/form';

/**
 * The public funnel, from ad click to submission.
 *
 * Every test opens its own browser context, so each one is a different visitor
 * with its own id, its own arm and its own draft. That is what makes the file
 * safe to run twice in a row against a process-scoped store: nothing here reads
 * a count that a previous run could have moved.
 */

test.describe('Potenzialanalyse — Formularstrecke', () => {
  test('führt einen qualifizierten Besucher bis zur Auswertung', async ({ visitor, form }) => {
    const recorder = new SubmitRecorder(visitor);

    await form.open();
    await form.walkToContact();
    await form.submit();

    await form.expectAnalysisResult();

    const [record] = await recorder.waitForResponses(1);
    expect(record?.status).toBe(200);
    expect(record?.body?.ok).toBe(true);
    expect(record?.body?.duplicate).toBe(false);
    expect(record?.body?.outcome).toBe('QUALIFIED');
    /* No Meta pixel is configured, and nothing is invented to fill the gap. */
    expect(record?.body?.capiConfigured).toBe(false);
    expect(record?.body?.capiQueued).toBe(true);
  });

  test('erzeugt aus mehreren Klicks auf „Absenden" genau eine Submission', async ({
    visitor,
    form,
  }) => {
    const recorder = new SubmitRecorder(visitor);

    await form.open();
    await form.walkToContact();
    await form.submit(4);

    await form.expectAnalysisResult();
    await recorder.expectExactlyOneSubmission(4);
  });

  test('beendet die Strecke vor der Kontaktabfrage, wenn das Budget ausschließt', async ({
    visitor,
    form,
  }) => {
    const recorder = new SubmitRecorder(visitor);

    await form.open();
    await form.walkToDisqualification();

    await form.expectNotAFitResult();
    /* A disqualified visitor is never asked for contact data, so nothing is
       sent and no lead is created. */
    await expect(visitor.getByLabel('E-Mail-Adresse')).toHaveCount(0);
    expect(await recorder.settled()).toEqual([]);
  });

  test('behält die Antworten beim Zurückgehen', async ({ form }) => {
    await form.open();
    await form.start();

    await form.answer(QUALIFIED_QUESTIONS[0]!);
    await form.next();
    await form.answer(QUALIFIED_QUESTIONS[1]!);
    await form.next();
    await form.expectOnStep(QUALIFIED_QUESTIONS[2]!.title);

    await form.back();
    await form.expectOnStep(QUALIFIED_QUESTIONS[1]!.title);
    for (const label of QUALIFIED_QUESTIONS[1]!.pick) {
      await expect(form.option(label, true)).toBeChecked();
    }

    await form.back();
    await form.expectOnStep(QUALIFIED_QUESTIONS[0]!.title);
    await expect(form.option(QUALIFIED_QUESTIONS[0]!.pick[0]!)).toBeChecked();

    /* Forward again: the answers are still the ones that were given, not a
       reset form. */
    await form.next();
    await form.expectOnStep(QUALIFIED_QUESTIONS[1]!.title);
    await form.next();
    await form.expectOnStep(QUALIFIED_QUESTIONS[2]!.title);
  });

  test('übersteht einen Reload mitten im Formular', async ({ visitor, form }) => {
    await form.open();
    await form.start();
    await form.answer(QUALIFIED_QUESTIONS[0]!);
    await form.next();
    await form.answer(QUALIFIED_QUESTIONS[1]!);
    await form.next();
    await form.expectOnStep(QUALIFIED_QUESTIONS[2]!.title);

    await visitor.reload();

    /* The draft is restored to the step the visitor was on, with the answers
       given so far. Contact data is deliberately never persisted. */
    await form.expectOnStep(QUALIFIED_QUESTIONS[2]!.title);
    await form.back();
    for (const label of QUALIFIED_QUESTIONS[1]!.pick) {
      await expect(form.option(label, true)).toBeChecked();
    }
  });

  test('speichert bei einem Abbruch keine Kontaktdaten im Browser', async ({ visitor, form }) => {
    await form.open();
    await form.walkToContact();

    /* Abandonment: the visitor leaves on the contact step without submitting. */
    const draft = await visitor.evaluate(() => {
      const entries: Record<string, string> = {};
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith('am_funnel_draft:')) entries[key] = sessionStorage.getItem(key) ?? '';
      }
      return entries;
    });

    const serialized = JSON.stringify(draft);
    expect(serialized).toContain('anfragen_pro_monat');
    for (const secret of ['Katrin', 'Bergmann', 'k.bergmann@', '987654']) {
      expect(serialized, `Kontaktdaten im Draft gefunden: ${secret}`).not.toContain(secret);
    }

    await visitor.goto(`/f/${FUNNEL_SLUG}`);
    /* The abandoned visit resumes where it stopped — with the qualification
       answers, and with the contact fields empty. */
    await form.expectOnStep(CONTACT_STEP_TITLE);
    await expect(visitor.getByLabel('Vorname')).toHaveValue('');
    await expect(visitor.getByLabel('E-Mail-Adresse')).toHaveValue('');
  });

  test('weist eine ungültige Postleitzahl mit deutscher Meldung zurück', async ({
    visitor,
    form,
  }) => {
    await form.open();
    await form.start();
    await form.answerQuestions();
    await form.expectOnStep(LOCATION_STEP_TITLE);

    await form.fillPostcode('1234');
    await form.next();

    /* Still on the same step, with the error announced and wired to the field. */
    await form.expectOnStep(LOCATION_STEP_TITLE);
    const error = visitor.locator('#feld-plz-fehler');
    await expect(error).toHaveText('Bitte geben Sie eine gültige fünfstellige Postleitzahl ein.');
    await expect(error).toHaveRole('alert');

    const field = visitor.getByLabel('Postleitzahl');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAttribute('aria-describedby', /feld-plz-fehler/);
    await expect(field).toBeFocused();

    await form.fillPostcode();
    await form.next();
    await form.expectOnStep(CONTACT_STEP_TITLE);
  });

  test('verlangt die Einwilligung, bevor etwas gesendet wird', async ({ visitor, form }) => {
    const recorder = new SubmitRecorder(visitor);

    await form.open();
    await form.start();
    await form.answerQuestions();
    await form.fillPostcode();
    await form.next();
    await form.fillContact(undefined, false);

    await expect(form.consentCheckbox()).not.toBeChecked();
    await form.submit();

    await expect(visitor.locator('#feld-einwilligung-fehler')).toHaveText(
      'Bitte stimmen Sie der Verarbeitung zu, um fortzufahren.',
    );
    expect(await recorder.settled(), 'Ohne Einwilligung darf nichts gesendet werden.').toEqual([]);
  });

  test('weist eine Übermittlung mit gefülltem Honeypot als Spam zurück', async ({
    visitor,
    form,
  }) => {
    const recorder = new SubmitRecorder(visitor);

    await form.open();
    await form.walkToContact();

    /* The honeypot is off-screen and removed from the accessibility tree; only
       a machine ever fills it. */
    await visitor.locator('#hp-hp_website').fill('https://spam.example', { force: true });
    await form.submit();

    const [record] = await recorder.waitForResponses(1);
    expect(record?.status).toBe(422);
    expect(record?.body?.code).toBe('SPAM_REJECTED');

    await expect(
      visitor.getByText(
        'Ihre Anfrage konnte nicht verarbeitet werden. Bitte laden Sie die Seite neu und versuchen Sie es erneut.',
      ),
    ).toBeVisible();
    /* No thank-you screen: a rejected submission is never rendered as success. */
    await expect(
      visitor.getByRole('heading', { name: 'Ihre Potenzialanalyse ist unterwegs' }),
    ).toHaveCount(0);
  });
});
