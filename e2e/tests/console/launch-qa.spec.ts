import { expect, test } from '../../fixtures/test';
import { CAMPAIGNS } from '../../fixtures/ids';

/**
 * The two launch gates, and the difference between them.
 *
 * A missing credential must block going live and must **not** block creating
 * the paused Meta draft — otherwise nothing can be prepared before the customer
 * has supplied anything, which is the whole point of the paused-draft workflow.
 */

test.describe('Launch-QA', () => {
  test('öffnet das Entwurfstor und hält das Live-Tor geschlossen', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.metaDraft, 'launch-qa');

    await expect(operator.locator('[data-gate="gate-meta-draft"]')).toHaveAttribute(
      'data-gate-open',
      'true',
    );
    await expect(operator.locator('[data-gate="gate-go-live"]')).toHaveAttribute(
      'data-gate-open',
      'false',
    );

    await expect(operator.locator('[data-gate="gate-meta-draft"]')).toContainText(
      'Der pausierte Entwurf darf erstellt werden. Er liefert nichts aus.',
    );
  });

  test('blockiert die Live-Schaltung, solange das HubSpot-Pflichtmapping fehlt', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.metaDraft, 'launch-qa');

    const mapping = operator.locator('[data-launch-check="hubspot_mapping_complete"]');
    await expect(mapping).toHaveAttribute('data-launch-check-status', 'AWAITING_EXTERNAL_INPUT');
    await expect(mapping).toContainText('noch nicht vom Kunden bestätigt');
    await expect(mapping).toContainText('Blockiert nur die Live-Schaltung');

    /* The dependent checks say why they cannot run rather than claiming to pass. */
    await expect(
      operator.locator('[data-launch-check="hubspot_test_lead_successful"]'),
    ).toContainText('Ohne bestätigtes Mapping kann kein Test-Lead gesendet werden.');
    await expect(
      operator.locator('[data-launch-check="contact_deal_association_verified"]'),
    ).toHaveAttribute('data-launch-check-status', 'AWAITING_EXTERNAL_INPUT');

    /* And the closed gate lists the mapping among its blockers. */
    const liveGate = operator.locator('[data-gate="gate-go-live"]');
    await expect(liveGate).toContainText('HubSpot');

    /* The remediation is a link to where it is done, not a dead end. */
    await expect(mapping.getByRole('link', { name: 'Zur Behebung' })).toHaveAttribute(
      'href',
      '/integrationen',
    );
  });

  test('blockiert die Live-Schaltung, solange keine Meta-Berechtigung vorliegt', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.metaDraft, 'launch-qa');

    const permissions = operator.locator('[data-launch-check="meta_permissions_valid"]');
    await expect(permissions).toHaveAttribute(
      'data-launch-check-status',
      'AWAITING_EXTERNAL_INPUT',
    );
    await expect(permissions).toContainText('Es liegt kein Meta-Zugriffstoken vor');

    await expect(operator.locator('[data-launch-check="pixel_capi_dedup_tested"]')).toHaveAttribute(
      'data-launch-check-status',
      'AWAITING_EXTERNAL_INPUT',
    );

    /* The same statement on the integrations side, so the two never disagree. */
    await operator.goto('/integrationen/meta');
    await expect(
      operator.getByText('Fixture-Modus – keine Verbindung zu Meta'),
    ).toBeVisible();
    await expect(
      operator.getByRole('heading', { name: 'Meta-App verbunden' }),
    ).toBeVisible();
    await expect(
      operator.getByText(
        'Fixture-Modus: Es besteht keine Verbindung zu Meta. Alle Daten stammen aus dem Testdatensatz.',
      ),
    ).toBeVisible();
  });

  test('lässt die Live-Schaltung durch keine aktive Schaltfläche zu', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.metaDraft, 'launch-qa');

    /* Whatever the tab offers, nothing that would take this campaign live may
       be actionable while checks are still waiting on external input. */
    await expect(
      operator.locator('[data-advance-action="LIVE"]:not([disabled])'),
      'Die Live-Schaltung war trotz offener Prüfungen auslösbar.',
    ).toHaveCount(0);
    await expect(operator.locator('[data-gate="gate-go-live"]')).toHaveAttribute(
      'data-gate-open',
      'false',
    );
  });

  test('bietet für einen pausierten Entwurf die Live-Schaltung als nächsten Schritt an', async ({
    operator,
    openCampaign,
  }) => {
    /*
     * DEFECT — see the report.
     *
     * `advanceOptionFor` in `apps/console/src/components/campaign/advance.ts`
     * returns the *first legal* transition of the tab, and for the Launch-QA tab
     * the candidate list starts with `READY_FOR_META_DRAFT`. From
     * `META_DRAFT_CREATED` that transition is legal (it goes backwards), so it
     * wins — and „Kampagne live schalten" is never offered anywhere in the
     * Campaign Room. The header's own `nextAction` says the opposite: it names
     * `go_live` / `approve_publish` and links to this tab.
     *
     * Reproduction: open „Benchmark Metallbau — Pilot" (state
     * „Meta-Entwurf erstellt (pausiert)") → Launch-QA. Under „Nächster Schritt
     * im Kampagnenablauf" the button reads „Für den Meta-Entwurf freigeben" and
     * targets `READY_FOR_META_DRAFT`.
     */
    await openCampaign(CAMPAIGNS.metaDraft, 'launch-qa');

    const advance = operator.locator('[data-advance-action]');
    await expect(advance).toHaveCount(1);
    await expect(
      advance,
      'Der angebotene nächste Schritt führt zurück statt zur Live-Schaltung.',
    ).toHaveAttribute('data-advance-action', 'LIVE');
    await expect(advance).toBeDisabled();
  });

  test('zeigt den pausierten Meta-Entwurf als Realität, nicht als Live-Zustand', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.metaDraft, 'strategie');

    await expect(operator.locator('[data-campaign-header]')).toHaveAttribute(
      'data-reality',
      'META_DRAFT_PAUSED',
    );
    await expect(operator.locator('[data-reality-banner="META_DRAFT_PAUSED"]')).toBeVisible();
  });
});
