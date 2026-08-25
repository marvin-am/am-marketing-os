import { expect, type Locator, type Page } from '@playwright/test';
import { ARMS, FUNNEL_SLUG, type ArmFixture } from './ids';

/**
 * A driver for the Potenzialanalyse multi-step form.
 *
 * The whole suite walks the same funnel, so the walk lives here once. It is
 * written in the visitor's vocabulary — "answer this question", "go back", "send
 * it twice" — which keeps the specs readable as statements about the product
 * rather than as sequences of clicks.
 *
 * Two things it does *not* do: it never reaches into the store, and it never
 * sleeps. Where it has to wait for wall-clock time — the form declares
 * `minCompletionSeconds`, and a submit faster than that is refused as
 * automation — it polls that exact condition rather than guessing a duration.
 */

/** `spec.submit.minCompletionSeconds` of the Potenzialanalyse form. */
export const MIN_COMPLETION_SECONDS = 3;

export interface QuestionStep {
  /** The step heading, which is the question itself. */
  title: string;
  /** Option labels to select. */
  pick: string[];
  multi?: boolean;
}

/** The five qualification questions, answered as a clearly qualified visitor. */
export const QUALIFIED_QUESTIONS: QuestionStep[] = [
  {
    title: 'Welche Rolle haben Sie im Betrieb?',
    pick: ['Geschäftsführung oder Inhaber:in'],
  },
  {
    title: 'Woher kommen Ihre Anfragen heute überwiegend?',
    pick: ['Empfehlungen und Mundpropaganda', 'Bestandskunden'],
    multi: true,
  },
  {
    title: 'Wie viele qualifizierte Anfragen erhalten Sie pro Monat?',
    pick: ['Bis zu 10'],
  },
  {
    title: 'Welches monatliche Werbebudget steht zur Verfügung?',
    pick: ['Mehr als 4.000 €'],
  },
  {
    title: 'Wann möchten Sie starten?',
    pick: ['So schnell wie möglich'],
  },
];

/** The budget answer that ends the form early, before any contact data. */
export const DISQUALIFYING_BUDGET_OPTION = 'Unter 500 €';

export const LOCATION_STEP_TITLE = 'Wo befindet sich Ihr Unternehmen?';
export const CONTACT_STEP_TITLE = 'Wohin dürfen wir das Ergebnis senden?';

export interface ContactData {
  vorname: string;
  nachname: string;
  email: string;
  firma: string;
  telefon: string;
}

export const QUALIFIED_CONTACT: ContactData = {
  vorname: 'Katrin',
  nachname: 'Bergmann',
  email: 'k.bergmann@bergmann-haustechnik.de',
  firma: 'Bergmann Haustechnik GmbH',
  telefon: '+49 2571 987654',
};

export const VALID_POSTCODE = '48431';

export class FormDriver {
  private startedAtMs: number | null = null;

  constructor(readonly page: Page) {}

  /* ---- navigation --------------------------------------------------- */

  /** Opens the public funnel. `url` lets a caller arrive via an ad link. */
  async open(url = `/f/${FUNNEL_SLUG}`): Promise<ArmFixture> {
    await this.page.goto(url);
    return this.arm();
  }

  /**
   * Which experiment arm this visitor was served, read off the intro copy. The
   * two arms differ only in headline and CTA label, which is what a funnel
   * experiment actually tests.
   */
  async arm(): Promise<ArmFixture> {
    const heading = this.page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
    const text = ((await heading.textContent()) ?? '').trim();
    const arm = ARMS.find((candidate) => candidate.headline === text);
    if (!arm) {
      throw new Error(`Unbekannter Experimentarm — Überschrift: „${text}"`);
    }
    return arm;
  }

  /** Presses the intro CTA and starts the clock the submit endpoint checks. */
  async start(): Promise<void> {
    const arm = await this.arm();
    await this.page.getByRole('button', { name: arm.ctaLabel }).click();
    this.startedAtMs = Date.now();
    await expect(this.stepHeading(QUALIFIED_QUESTIONS[0]!.title)).toBeVisible();
  }

  stepHeading(title: string): Locator {
    return this.page.getByRole('heading', { level: 1, name: title });
  }

  async expectOnStep(title: string): Promise<void> {
    await expect(this.stepHeading(title)).toBeVisible();
  }

  /* ---- answering ------------------------------------------------------ */

  /**
   * One answer option.
   *
   * Matched by substring rather than exactly, because the *first* option of
   * every choice field currently carries the question text in front of its own
   * label — the field-level `<label for>` points at it. That is a product
   * defect, asserted by `tests/funnel/accessibility.spec.ts`; the driver has to
   * keep working while it stands, but it does not paper over it.
   */
  option(label: string, multi = false): Locator {
    return this.page.getByRole(multi ? 'checkbox' : 'radio', { name: label });
  }

  async answer(step: QuestionStep): Promise<void> {
    await this.expectOnStep(step.title);
    for (const label of step.pick) {
      const control = this.option(label, step.multi === true);
      await control.check();
      await expect(control).toBeChecked();
    }
  }

  /** Advances one step. Fails loudly if the button is not the expected one. */
  async next(label = 'Weiter'): Promise<void> {
    await this.page.getByRole('button', { name: label, exact: true }).click();
  }

  async back(): Promise<void> {
    await this.page.getByRole('button', { name: 'Zurück', exact: true }).click();
  }

  /** Answers the five qualification questions as a qualified visitor. */
  async answerQuestions(): Promise<void> {
    for (const step of QUALIFIED_QUESTIONS) {
      await this.answer(step);
      await this.next();
    }
  }

  /**
   * Answers up to and including the budget question, choosing the option that
   * disqualifies. The form ends there: a visitor who is not a fit is never
   * asked for contact data in the first place.
   */
  async walkToDisqualification(): Promise<void> {
    await this.start();
    for (const step of QUALIFIED_QUESTIONS.slice(0, 3)) {
      await this.answer(step);
      await this.next();
    }
    await this.answer({ ...QUALIFIED_QUESTIONS[3]!, pick: [DISQUALIFYING_BUDGET_OPTION] });
    await this.next();
  }

  async fillPostcode(value = VALID_POSTCODE): Promise<void> {
    await this.expectOnStep(LOCATION_STEP_TITLE);
    await this.page.getByLabel('Postleitzahl').fill(value);
  }

  async fillContact(data: ContactData = QUALIFIED_CONTACT, consent = true): Promise<void> {
    await this.expectOnStep(CONTACT_STEP_TITLE);
    await this.page.getByLabel('Vorname').fill(data.vorname);
    await this.page.getByLabel('Nachname').fill(data.nachname);
    await this.page.getByLabel('E-Mail-Adresse').fill(data.email);
    await this.page.getByLabel('Unternehmen').fill(data.firma);
    await this.page.getByLabel('Telefonnummer').fill(data.telefon);
    if (consent) await this.consentCheckbox().check();
  }

  consentCheckbox(): Locator {
    return this.page.getByRole('checkbox', { name: /Ich willige ein/ });
  }

  /* ---- submitting ----------------------------------------------------- */

  /**
   * Waits until the form has been open at least as long as the spec's declared
   * `minCompletionSeconds`.
   *
   * This is not padding: `assessSubmission` treats a faster submit as
   * automation and refuses it, so a test that submits in 400 ms would be
   * asserting the bot path while claiming to assert the happy path. The
   * condition polled is the product's own rule, and `elapsedSeconds` is rounded,
   * which is where the half-second comes from.
   */
  async awaitMinimumCompletionTime(): Promise<void> {
    if (this.startedAtMs === null) return;
    const readyAtMs = this.startedAtMs + MIN_COMPLETION_SECONDS * 1000 - 500;
    await expect
      .poll(() => Date.now() >= readyAtMs, {
        message: 'Formular war kürzer offen als die deklarierte Mindestdauer.',
        timeout: 10_000,
      })
      .toBe(true);
  }

  submitButton(): Locator {
    return this.page.getByRole('button', { name: 'Auswertung anfordern', exact: true });
  }

  /**
   * Presses the final submit, `times` times.
   *
   * A single press goes through the real UI. A burst is dispatched inside one
   * synchronous task in the page, because that is what an impatient double tap
   * on a slow connection actually is: several clicks land before React has
   * re-rendered the button as disabled. Driving them one Playwright call at a
   * time would instead let the first request finish and leave nothing to click,
   * which would test the button rather than the idempotency of the endpoint.
   */
  async submit(times = 1): Promise<void> {
    await this.awaitMinimumCompletionTime();
    const button = this.submitButton();
    await expect(button).toBeEnabled();
    if (times === 1) {
      await button.click();
      return;
    }
    await button.evaluate((element, count) => {
      for (let attempt = 0; attempt < count; attempt += 1) {
        (element as HTMLButtonElement).click();
      }
    }, times);
  }

  /* ---- results -------------------------------------------------------- */

  async expectAnalysisResult(): Promise<void> {
    await expect(
      this.page.getByRole('heading', { level: 1, name: 'Ihre Potenzialanalyse ist unterwegs' }),
    ).toBeVisible();
  }

  async expectNotAFitResult(): Promise<void> {
    await expect(
      this.page.getByRole('heading', { level: 1, name: 'Wir sind aktuell nicht die richtige Wahl' }),
    ).toBeVisible();
  }

  /** The whole qualified walk, up to but not including the final submit. */
  async walkToContact(): Promise<void> {
    await this.start();
    await this.answerQuestions();
    await this.fillPostcode();
    await this.next();
    await this.fillContact();
  }
}
