import { expect, test } from '../../fixtures/test';
import {
  APPROVAL_LABELS_DE,
  CAMPAIGNS,
  CREATIVE_CONCEPT_NAMES,
  FUNNEL_PROPOSAL_NAMES,
} from '../../fixtures/ids';

/**
 * The Campaign Room as a reviewer sees it.
 *
 * The proposal is the artefact the whole workflow rests on, so this file checks
 * that it is *reviewable*: the angle, the offer and the hypothesis are stated,
 * six creative concepts are shown with the principle each one tests, and the
 * funnel mix carries two multi-step forms plus a further variant to compare
 * them against.
 */

test.describe('Kampagnenvorschlag', () => {
  test('macht Angle, Offer, Kernbotschaft und Hypothese prüfbar', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.strategyReview, 'strategie');

    await expect(operator.getByRole('region', { name: 'Angle' })).toContainText(
      'Nachfolge planen, bevor sie drängt',
    );
    await expect(operator.getByRole('region', { name: 'Offer' })).toContainText(
      'Strategiegespräch',
    );

    const message = operator.getByRole('region', { name: 'Kernbotschaft und Hypothese' });
    await expect(message).toContainText('Nachfolge planen, bevor sie drängt');
    await expect(message).toContainText('Kosten je qualifiziertem VQ sinken');

    /* Every claim carries its confidence, and a hypothesis is labelled as one
       rather than presented as a fact. */
    const claims = operator.getByRole('region', { name: 'Claims' });
    await expect(claims.locator('[data-claim-confidence="FACT"]').first()).toBeVisible();
    await expect(claims.locator('[data-claim-confidence="HYPOTHESIS"]').first()).toBeVisible();

    /* And the historical basis the proposal was built on. */
    await expect(operator.getByRole('region', { name: 'Belege aus der Historie' })).toContainText(
      '42 Erstgespräche',
    );
    await expect(
      operator.getByRole('region', { name: 'Ähnliche Kampagnen aus der Historie' }),
    ).toContainText(CAMPAIGNS.paused);
  });

  test('zeigt sechs Creative-Konzepte mit unterschiedlichen Prinzipien', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.strategyReview, 'creatives');

    const cards = operator.locator('[data-creative-key]');
    await expect(cards, 'Ein Vorschlag muss sechs Creative-Konzepte enthalten.').toHaveCount(6);

    for (const name of CREATIVE_CONCEPT_NAMES) {
      await expect(operator.getByRole('heading', { name, exact: true })).toBeVisible();
    }

    /* Each concept states the hypothesis it tests and the rationale for it —
       a board of six visually different pictures is not a test of six ideas. */
    await expect(operator.getByText('Die Zielgruppe reagiert stärker auf das konkret')).toBeVisible();

    /* Six conceptually distinct concepts clear the diversity gate. */
    await expect(operator.locator('[data-diversity-blocked="false"]')).toBeVisible();
  });

  test('zeigt zwei Multi-Step-Formulare und eine weitere Variante', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.strategyReview, 'funnel');

    const variants = operator.locator('[data-funnel-kind]');
    await expect(variants).toHaveCount(3);
    await expect(operator.locator('[data-funnel-kind="MULTI_STEP_FORM"]')).toHaveCount(2);
    await expect(operator.locator('[data-funnel-kind="LANDING_PAGE"]')).toHaveCount(1);

    await expect(operator.getByText(FUNNEL_PROPOSAL_NAMES.formSix)).toBeVisible();
    await expect(operator.getByText(FUNNEL_PROPOSAL_NAMES.formFour)).toBeVisible();
    await expect(operator.getByText(FUNNEL_PROPOSAL_NAMES.landingPage)).toBeVisible();

    /* The two forms differ in the variable the test is about. */
    await expect(operator.getByText('6 Qualifizierungsfragen')).toBeVisible();
    await expect(operator.getByText('4 Qualifizierungsfragen')).toBeVisible();
  });

  test('legt den Testplan mit Mindestvolumen, Stop- und Skalierungsregeln offen', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.strategyReview, 'testplan');

    await expect(operator.getByRole('region', { name: 'Hypothese und Testvariable' })).toContainText(
      'Anzahl der Qualifizierungsfragen',
    );
    await expect(
      operator.getByRole('region', { name: 'Volumen, Laufzeit und Datenreife' }),
    ).toContainText('200');
    const rules = operator.getByRole('region', { name: 'Stop- und Skalierungsregeln' });
    await expect(rules).toContainText('Maximal 20 % Erhöhung je Aktion');
    await expect(rules).toContainText(
      'Stoppen, wenn die Eignungsfragen geändert werden — die Arme sind dann nicht mehr vergleichbar.',
    );
  });
});

test.describe('Freigaben', () => {
  test('sperrt die Asset-Freigabe, solange zwei Konzepte dieselbe Idee erzählen', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.assetReview, 'creatives');

    await expect(operator.locator('[data-diversity-blocked="true"]')).toBeVisible();
    const blocked = operator.locator('[data-asset-gate-blocked]');
    await expect(blocked).toBeVisible();
    /* The refusal names the colliding pair; "zu wenige" alone is unactionable. */
    await expect(blocked).toContainText('Vierzehn Anfragen im Quartal');
    await expect(blocked).toContainText('Kein Budget für Experimente');

    await expect(
      operator.getByRole('button', { name: 'Freigeben', exact: true }),
    ).toBeDisabled();
    await expect(operator.locator('[data-advance-action]')).toBeDisabled();
  });

  test('macht eine Freigabe durch eine spätere Claim-Änderung ungültig', async ({
    operator,
    openCampaign,
  }) => {
    /*
     * The console has no claim editor, so the change itself is modelled by the
     * fixture: this campaign's STRATEGY approval was granted against a content
     * hash that the current claims no longer produce. What is asserted here is
     * everything the product has to do about it — see the report.
     */
    await openCampaign(CAMPAIGNS.invalidatedApproval, 'strategie');

    const notice = operator.locator('[data-approval-invalid]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('durch eine Änderung ungültig');
    await expect(notice).toContainText(
      'Eine vorgezogene Qualifizierung senkt die No-Show-Quote spürbar.',
    );

    /* The next step stays locked until the current content is approved again. */
    await expect(operator.getByRole('button', { name: 'Erneut freigeben' })).toBeVisible();

    /* And the change is in the history with its before/after. */
    await openCampaign(CAMPAIGNS.invalidatedApproval, 'versionen');
    await expect(operator.locator('[data-audit-action="claim.changed"]')).toContainText(
      'Claim geändert',
    );
    await expect(operator.locator('[data-audit-action="approval.invalidated"]')).toContainText(
      'ungültig',
    );
    await expect(operator.locator('[data-audit-action="claim.changed"]')).toContainText(
      'senkt die No-Show-Quote um 30 %',
    );
  });

  test('erteilt eine Freigabe und zeigt sie gegen den aktuellen Inhaltsstand', async ({
    operator,
    openCampaign,
  }) => {
    await openCampaign(CAMPAIGNS.assetReview, 'strategie');

    /* Idempotent by design: the fixture store is process-scoped, so a second run
       of this file starts from an already-approved strategy. Approving again is
       the same operation and the assertion is the same either way. */
    await operator.getByRole('button', { name: /^(Freigeben|Erneut freigeben)$/ }).click();
    await expect(
      operator.getByText(`Freigabe „${APPROVAL_LABELS_DE.STRATEGY}" gespeichert.`),
    ).toBeVisible();
    await expect(operator.locator('[data-approval-invalid]')).toHaveCount(0);

    /* With a valid approval the next state change becomes available. */
    const advance = operator.locator('[data-advance-action]');
    await expect(advance).toBeEnabled();
  });
});
