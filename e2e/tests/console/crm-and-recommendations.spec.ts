import { expect, test } from '../../fixtures/test';
import { CAMPAIGNS, FUNNEL_PROPOSAL_NAMES } from '../../fixtures/ids';

/**
 * What happens after the lead: the CRM strecke, the failed sync, and the
 * recommendation that comes out of the numbers.
 *
 * The recurring rule in this file is that a local click is never a provider
 * confirmation. With external writes off, executing a recommendation and
 * retrying a lead sync both end as dry runs — visibly, and never as success.
 */

test.describe('Leads und Vertrieb', () => {
  test('zeigt die ganze Strecke inklusive No-Show und verlorener Abschlüsse', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.live, 'leads-sales');

    for (const stage of [
      'leads',
      'vq_scheduled',
      'vq_attended',
      'vq_no_show',
      'qualified_vq',
      'opportunities',
      'closed_won',
      'closed_lost',
    ]) {
      await expect(
        operator.locator(`[data-crm-stage="${stage}"]`),
        `Die Stufe „${stage}" fehlt in der CRM-Strecke.`,
      ).toBeVisible();
    }

    /* No-show and closed lost are shown as their own outcomes, not folded into
       a single "nicht gewonnen" bucket. */
    await expect(operator.locator('[data-crm-stage="vq_no_show"]')).toContainText('No-Show');
    await expect(operator.locator('[data-crm-stage="closed_lost"]')).toContainText('Verloren');

    /* Every rate carries its numerator and denominator, never a bare percentage. */
    const won = operator.locator('[data-crm-stage="closed_won"]');
    await expect(won.locator('[data-am-rate-basis]')).toBeVisible();
    await expect(won.locator('[data-am-rate-basis]')).toContainText('/');

    /* Individual leads carry their VQ outcome, including the no-shows. */
    await expect(operator.getByText('Nicht erschienen').first()).toBeVisible();
    await expect(operator.getByText('Qualifiziert').first()).toBeVisible();
  });

  test('weist den Umsatz der richtigen Kampagne und dem richtigen Arm zu', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.live, 'leads-sales');

    /* Revenue is attributed on the campaign it was earned on, with its maturity
       and attribution coverage beside it rather than as a bare figure. */
    const revenue = operator.getByText('Attribuierter Umsatz').locator('..');
    await expect(revenue).toContainText('€');
    await expect(revenue).toContainText('%');

    /* A different campaign must not inherit it. */
    await openCampaign(CAMPAIGNS.strategyReview, 'leads-sales');
    await expect(operator.getByText('Noch keine Leads.')).toBeVisible();

    /* And the delivery breakdown separates the funnel arms, so the number can
       be read per variant rather than only per campaign. */
    await openCampaign(CAMPAIGNS.live, 'live-performance');
    await expect(operator.getByText(FUNNEL_PROPOSAL_NAMES.formSix).first()).toBeVisible();
    await expect(operator.getByText(FUNNEL_PROPOSAL_NAMES.formFour).first()).toBeVisible();
    await expect(operator.getByText(FUNNEL_PROPOSAL_NAMES.landingPage).first()).toBeVisible();
  });

  test('überlebt einen HubSpot-Ausfall und bietet eine Wiederholung an', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.live, 'leads-sales');

    const failed = operator.locator('[data-sync-status="FAILED_RETRYING"]');
    await expect(failed.first()).toBeVisible();
    /* The lead itself is intact — the outage cost a sync, not a lead. */
    await expect(failed.first()).toContainText('Lead ');
    await expect(failed.first()).toContainText(
      'HubSpot antwortete mit 429 (Rate Limit). Wiederholung geplant.',
    );
    await expect(operator.getByText(/\d+ fehlgeschlagene Übertragungen/)).toBeVisible();

    const before = await failed.count();
    await failed.first().getByRole('button', { name: 'Erneut übertragen' }).click();

    /* Writes are off: the retry is prepared and shown as a dry run. */
    const notice = operator.locator('[data-dry-run="true"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Dry-Run – nicht ausgeführt');
    await expect(notice).toContainText('HUBSPOT');
    await expect(operator.getByText('Lead erneut an HubSpot übertragen.')).toHaveCount(0);

    /* Nothing was lost by trying. */
    await operator.reload();
    await expect(operator.locator('[data-sync-status="FAILED_RETRYING"]')).toHaveCount(before);
  });
});

test.describe('Empfehlungen', () => {
  test('begründet eine Skalierung mit Fakten, Vergleichsbasis und Unsicherheit', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.live, 'empfehlungen');

    const scale = operator.locator('[data-recommendation-action="INCREASE_BUDGET"]');
    await expect(scale).toBeVisible();
    await expect(scale).toContainText('Tagesbudget um 20 % erhöhen');

    /* Not an opinion: every fact has its numerator, denominator and the value it
       is compared against. */
    await expect(scale.locator('[data-fact-metric="cost_per_qualified_vq"]')).toBeVisible();
    await expect(scale.locator('[data-fact-metric="submission_rate"]')).toBeVisible();
    await expect(scale.locator('[data-am-rate-basis]').first()).toContainText('/');
    await expect(scale.locator('[data-fact-comparison]').first()).toContainText('Zielwert');
    await expect(scale.locator('[data-comparison-basis]')).toContainText(
      'Verglichen mit dem hinterlegten Zielwert',
    );
    await expect(scale).toContainText('Die CRM-Ergebnisse der letzten sieben Tage sind noch nicht reif.');

    /* The exact external action, before anything is confirmed. */
    await expect(scale).toContainText('Erhöht das Tagesbudget der Meta-Kampagne');
    await expect(scale).toContainText('120214880031240500');
  });

  test('führt nichts aus, bevor der Nutzer die Vorschau bestätigt hat', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.live, 'empfehlungen');

    const scale = operator.locator('[data-recommendation-action="INCREASE_BUDGET"]');
    await scale.getByRole('button', { name: 'Annehmen und ausführen' }).click();

    const dialog = operator.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('"daily_budget"');

    const confirm = dialog.getByRole('button', { name: 'An Meta senden' });
    await expect(confirm, 'Die Aktion war ohne Bestätigungsphrase auslösbar.').toBeDisabled();

    await dialog.getByRole('textbox').fill('ausführen');
    await expect(confirm, 'Eine ungenaue Phrase hat die Aktion freigegeben.').toBeDisabled();

    await dialog.getByRole('textbox').fill('AUSFÜHREN');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    /* Writes are off, so the provider was not called and nothing is claimed. */
    const notice = operator.locator('[data-dry-run="true"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Dry-Run – nicht ausgeführt');
    await expect(notice).toContainText('campaign.update.daily_budget');
    await expect(scale.locator('[data-execution-confirmed]')).toHaveCount(0);
    await expect(operator.getByText('Empfehlung ausgeführt und vom Provider bestätigt.')).toHaveCount(
      0,
    );
  });

  test('zeigt nur eine vom Provider bestätigte Aktion als erledigt', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.live, 'empfehlungen');

    const paused = operator.locator('[data-recommendation-action="PAUSE_CREATIVE"]');
    await expect(paused.locator('[data-execution-confirmed]')).toBeVisible();
    await expect(paused).toContainText('Von Meta bestätigt');
    await expect(paused).toContainText(
      'Nur ein bestätigter Befehl wird hier als erledigt angezeigt.',
    );
  });

  test('erklärt eine Empfehlung ohne externe Aktion als solche', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.live, 'empfehlungen');

    const collect = operator.locator('[data-recommendation-action="COLLECT_MORE_DATA"]');
    await expect(collect).toContainText('Keine — diese Empfehlung verändert nichts bei Meta.');
    await expect(collect).toContainText('Mindestvolumen je Arm');
  });
});
