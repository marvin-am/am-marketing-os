import { expect, test } from '../../fixtures/test';

/**
 * The transactional outbox, which is where a provider outage becomes visible
 * instead of becoming a silent gap in the numbers.
 *
 * Two failure modes get their own case, because they need different answers: a
 * rate limit is transient and retries itself with backoff, while a dead letter
 * has given up and needs a person. Neither may ever be reported as delivered on
 * the strength of a local click.
 */

const RATE_LIMITED_EVENT = 'lead:7d2c9f61-4e0b-4a15-8c31-2b7d9c1e6f0a';
const DEAD_LETTER_EVENT = 'stage:6b0d3e82-5a17-4c94-8f26-1d7e9b0a3c58:CLOSED_WON:4';

test.describe('Outbox und Dead Letter', () => {
  test('zeigt ein Rate-Limit als wiederholbaren Fehler mit der Antwort des Anbieters', async ({
    operator,
  }) => {
    await operator.goto('/integrationen/outbox');

    const row = operator.locator(`[data-outbox-row="${RATE_LIMITED_EVENT}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('contact.upsert');
    await expect(row).toContainText('HubSpot');
    await expect(row).toContainText('Fehlgeschlagen – Wiederholung');
    /* The attempt count is what tells an operator whether backoff is working. */
    await expect(row).toContainText('3');

    await row.getByRole('button').first().click();
    const detail = operator.locator(`[data-outbox-detail="${RATE_LIMITED_EVENT}"]`);
    await expect(detail).toContainText('HTTP 429 – Rate Limit erreicht. Wiederholung nach Backoff.');
    /* The stored provider response is redacted — no PII is ever kept. */
    await expect(detail).toContainText('RATE_LIMIT');
    await expect(detail).toContainText('[redigiert]');
    await expect(detail).toContainText(
      'Personenbezogene Felder werden vor dem Speichern entfernt; die Rohantwort wird nie abgelegt.',
    );
  });

  test('nennt Dead Letter beim Namen und macht die Lücke in den Zahlen explizit', async ({
    operator,
  }) => {
    await operator.goto('/integrationen/outbox');

    await expect(operator.getByText('1 Ereignis hat aufgegeben')).toBeVisible();
    await expect(
      operator.getByText(
        'Diese Ereignisse haben den Anbieter nie erreicht. Alle Kennzahlen, die auf ihnen beruhen, sind unvollständig, bis sie erfolgreich zugestellt wurden.',
      ),
    ).toBeVisible();

    const row = operator.locator(`[data-outbox-row="${DEAD_LETTER_EVENT}"]`);
    await expect(row).toContainText('Dead Letter');
    await expect(row).toContainText('8');
  });

  test('wiederholt ein Dead-Letter-Ereignis als Dry-Run und meldet keinen Erfolg', async ({
    operator,
  }) => {
    await operator.goto('/integrationen/outbox');

    const row = operator.locator(`[data-outbox-row="${DEAD_LETTER_EVENT}"]`);
    await row.getByRole('button', { name: 'Erneut senden' }).click();

    const dialog = operator.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    /* The dialog previews exactly what would be sent, including the dedup id. */
    await expect(dialog).toContainText(DEAD_LETTER_EVENT);
    await expect(dialog).toContainText(
      'Durch die Deduplizierungs-ID entsteht beim Anbieter kein zweites Ereignis.',
    );
    await dialog.getByRole('button', { name: 'Erneut senden' }).click();

    /* Writes are off, so the retry is a dry run — and a dry run is never
       rendered as a success (AGENTS.md rule 2). */
    const notice = operator.locator('[data-dry-run="true"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Dry-Run – nicht ausgeführt');
    await expect(notice).toContainText('Der Conversions-API-Versand ist deaktiviert');

    /* Nothing claims the provider accepted *this* event. */
    await expect(row).not.toContainText('Vom Provider bestätigt');
    await expect(row).toContainText('Dead Letter');

    /* And after a reload the event is still in the dead letter, because nothing
       was actually delivered. */
    await operator.reload();
    await expect(operator.locator(`[data-outbox-row="${DEAD_LETTER_EVENT}"]`)).toContainText(
      'Dead Letter',
    );
  });

  test('zeigt eine tatsächlich bestätigte Zustellung als bestätigt', async ({ operator }) => {
    await operator.goto('/integrationen/outbox');

    const row = operator.locator(
      '[data-outbox-row="stage:4e8a1c05-9b73-4d26-8017-2f5c6b3a9d84:VQ_PASSED:2"]',
    );
    await expect(row).toContainText('Vom Provider bestätigt');
    await expect(row).toContainText('keine Wiederholung');
  });
});
