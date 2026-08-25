import { expect, test } from '../../fixtures/test';
import { PUBLISHED_FORM_VERSION_ID } from '../../fixtures/ids';

/**
 * Immutability of a published form version — the rule the running funnel
 * experiment depends on.
 *
 * The control arm of the running experiment serves
 * `PUBLISHED_FORM_VERSION_ID`. If that document could be edited in place, the
 * two arms would silently stop measuring the same thing and every result
 * collected so far would become uninterpretable. So the builder does not offer
 * a save on it at all: the only way forward is a new draft version.
 */

const STEP_TITLE = 'Welche Rolle haben Sie im Betrieb?';

test.describe('Veröffentlichte Formularversion', () => {
  test('ist schreibgeschützt und bietet nur den Weg über eine neue Version', async ({
    operator,
  }) => {
    await operator.goto(`/builder/form/${PUBLISHED_FORM_VERSION_ID}`);

    await expect(operator.getByText('Veröffentlichte Version — schreibgeschützt')).toBeVisible();
    /* Not a disabled button with no explanation — the controls are simply gone,
       and the one offered path says what it will do. */
    await expect(operator.getByRole('button', { name: 'Entwurf speichern' })).toHaveCount(0);
    await expect(operator.getByRole('button', { name: 'Veröffentlichen' })).toHaveCount(0);
    await expect(
      operator.getByRole('button', { name: 'Als neuen Entwurf bearbeiten' }),
    ).toBeVisible();

    /* Every editor control on the page is read-only. */
    const heading = operator.getByLabel('Überschrift');
    await expect(heading).toHaveValue(STEP_TITLE);
    await expect(heading).toBeDisabled();
  });

  test('erzeugt beim Bearbeiten eine neue Entwurfsversion und lässt die alte unberührt', async ({
    operator,
  }) => {
    await operator.goto(`/builder/form/${PUBLISHED_FORM_VERSION_ID}`);
    await operator.getByRole('button', { name: 'Als neuen Entwurf bearbeiten' }).click();

    /* The builder navigates to the new draft; its id is not the published one. */
    await expect(operator).not.toHaveURL(new RegExp(PUBLISHED_FORM_VERSION_ID));
    await expect(operator).toHaveURL(/\/builder\/form\/[0-9a-f-]{36}$/);
    await expect(operator.getByText('Entwurf', { exact: true }).first()).toBeVisible();

    const edited = 'Welche Rolle haben Sie im Betrieb — E2E?';
    const heading = operator.getByLabel('Überschrift');
    await expect(heading).toBeEnabled();
    await heading.fill(edited);
    await expect(operator.getByText('Nicht gespeicherte Änderungen')).toBeVisible();

    await operator.getByRole('button', { name: 'Entwurf speichern' }).click();
    await expect(operator.getByText(/Entwurf \d+ gespeichert\./)).toBeVisible();

    await operator.reload();
    await expect(operator.getByLabel('Überschrift')).toHaveValue(edited);

    /* The published version still says what was actually delivered. */
    await operator.goto(`/builder/form/${PUBLISHED_FORM_VERSION_ID}`);
    await expect(
      operator.getByLabel('Überschrift'),
      'Die veröffentlichte Version wurde durch die Bearbeitung verändert.',
    ).toHaveValue(STEP_TITLE);
    await expect(operator.getByText('Veröffentlichte Version — schreibgeschützt')).toBeVisible();
  });

  test('stellt eine alte Version als neuen Entwurf wieder her statt sie zu überschreiben', async ({
    operator,
  }) => {
    await operator.goto(`/builder/form/${PUBLISHED_FORM_VERSION_ID}`);
    await operator.getByRole('button', { name: 'Versionen' }).click();

    const history = operator.getByRole('region', { name: 'Versionsverlauf' });
    await expect(history).toContainText(
      'Wiederherstellen überschreibt nichts: Es entsteht eine neue Entwurfsversion mit dem Inhalt der gewählten Version.',
    );
    await expect(history.getByText(/Veröffentlicht v\d+/)).toBeVisible();

    await history.getByRole('button', { name: 'Als Entwurf wiederherstellen' }).first().click();
    await expect(
      operator.getByText(/als neuer Entwurf \d+ wiederhergestellt/).first(),
    ).toBeVisible();
    await expect(operator).not.toHaveURL(new RegExp(PUBLISHED_FORM_VERSION_ID));
  });
});
