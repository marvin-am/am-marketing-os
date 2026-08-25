import { expect, test } from '../../fixtures/test';
import { APPROVAL_LABELS_DE, CAMPAIGNS } from '../../fixtures/ids';

/**
 * The audit log, and the gap in it.
 *
 * The Versionen tab states that it lists "jede Änderung mit Akteur, Zeitpunkt
 * und redigierter Nutzlast". The first test holds the delivered campaign's chain
 * to that claim. The second holds an action taken *in this session* to the same
 * claim — and currently fails, because no audit sink is installed.
 */

test.describe('Audit-Log', () => {
  test('enthält die vollständige Kette einer ausgelieferten Kampagne', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.live, 'versionen');

    const expected = [
      'campaign.created',
      'proposal.generated',
      'approval.granted',
      'creative.approved',
      'launch_qa.evaluated',
      'meta.command_requested',
      'campaign.state_changed',
      'recommendation.generated',
    ];
    for (const action of expected) {
      await expect(
        operator.locator(`[data-audit-action="${action}"]`),
        `Im Audit-Log fehlt „${action}".`,
      ).toHaveCount(1);
    }

    /* The Meta command is recorded as what it was: a *paused* draft. */
    const metaCommand = operator.locator('[data-audit-action="meta.command_requested"]');
    await expect(metaCommand).toContainText('Pausierter Meta-Entwurf angefordert.');
    await expect(metaCommand).toContainText('CREATE_DRAFT_CAMPAIGN');
    await expect(metaCommand).toContainText('PAUSED');

    /* Each entry names an actor, a time and a correlation id. */
    const created = operator.locator('[data-audit-action="campaign.created"]');
    await expect(created).toContainText('Korrelation:');
    await expect(created).toContainText(/\d{2}\.\d{2}\.\d{4}/);

    /* And the versions above it are immutable snapshots with a real diff. */
    await expect(operator.locator('[data-version="2"]')).toContainText('Aktuell');
    await expect(operator.locator('[data-version="1"]')).toContainText('Version 1');
    await expect(
      operator.getByText(
        'Veröffentlichte Versionen sind unveränderlich. Eine Änderung erzeugt eine neue Version.',
      ),
    ).toBeVisible();
  });

  test('schreibt eine im Konsolenbetrieb erteilte Freigabe in das Audit-Log', async ({
    operator,
    openCampaign,
  }) => {
    /*
     * DEFECT — see the report.
     *
     * `defineAction` calls `ctx.audit(...)` for every mutating action, but
     * `setAuditSink` is never called anywhere in the app, so the sink is null
     * and the entry is dropped with an `audit_sink_missing` warning. In demo
     * mode the Versionen tab therefore shows only the seeded history, and an
     * approval granted a second ago is nowhere in it — while the page states
     * that it lists every change.
     *
     * Reproduction: sign in, open a campaign's Strategie tab, press
     * „Freigeben", wait for „Freigabe „Strategie" gespeichert.", open the
     * Versionen tab. The audit log is unchanged.
     */
    const campaignId = await openCampaign(CAMPAIGNS.assetReview, 'versionen');
    const before = await operator.locator('[data-audit-action]').count();
    expect(before, 'Für diese Kampagne gibt es überhaupt keine Audit-Einträge.').toBeGreaterThan(0);

    await operator.goto(`/kampagnen/${campaignId}/strategie`);
    await operator.getByRole('button', { name: /^(Freigeben|Erneut freigeben)$/ }).click();
    await expect(
      operator.getByText(`Freigabe „${APPROVAL_LABELS_DE.STRATEGY}" gespeichert.`),
    ).toBeVisible();

    await operator.goto(`/kampagnen/${campaignId}/versionen`);
    const after = await operator.locator('[data-audit-action]').count();
    expect(
      after,
      'Die soeben erteilte Freigabe steht nicht im Audit-Log — es wird kein Audit-Sink installiert.',
    ).toBeGreaterThan(before);
  });
});
