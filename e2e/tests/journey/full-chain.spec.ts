import type { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { FUNNEL_URL } from '../../fixtures/config';
import { FormDriver } from '../../fixtures/form';
import { waitForConsoleReady, waitForInteractive } from '../../fixtures/hydration';
import {
  APPROVAL_LABELS_DE,
  CAMPAIGNS,
  CREATIVE_CONCEPT_NAMES,
  FUNNEL_FIXTURE_IDS,
  FUNNEL_PROPOSAL_NAMES,
  FUNNEL_SLUG,
  PUBLISHED_FORM_VERSION_ID,
} from '../../fixtures/ids';
import { launchUrlFor } from '../../fixtures/launch-token';
import { SubmitRecorder } from '../../fixtures/network';

/**
 * The whole chain the business depends on, in one test.
 *
 * Proposal → review → approvals → launch QA → paused Meta draft → ad click →
 * stable arm → five questions → postcode → contact → one submission → CRM →
 * revenue → deduplicated outcome → scale recommendation → audit trail.
 *
 * Two things shape how it is written.
 *
 * **The fixture stores are process-scoped.** They live in module scope inside
 * the two Next servers and reset when a server restarts. The campaign this test
 * walks forward therefore starts either at `STRATEGY_REVIEW` (fresh process) or
 * at whatever the previous run left it at. Every step converges rather than
 * assumes: `advanceTo` performs the transition when it is offered and asserts
 * the campaign is already at or past that state when it is not, and approvals
 * are idempotent by construction. The test can be run any number of times in a
 * row against the same process.
 *
 * **External writes are off.** That is not an obstacle to the chain, it is part
 * of it: a Meta draft is created *paused*, a HubSpot retry ends as a dry run,
 * and only a `PROVIDER_CONFIRMED` command is ever rendered as done. Where a step
 * of the chain can only be reached through a fixture-provider control rather
 * than a console screen, the report says so.
 */

/** The six concept keys the proposal generator emits. */
const CREATIVE_KEYS = ['concept_1', 'concept_2', 'concept_3', 'concept_4', 'concept_5', 'concept_6'];

/** Campaign states in workflow order, so "already past this" is decidable. */
const STATE_ORDER = [
  'IDEA',
  'PROPOSED',
  'STRATEGY_REVIEW',
  'STRATEGY_APPROVED',
  'ASSET_GENERATION',
  'ASSET_REVIEW',
  'TEST_PLAN_REVIEW',
  'READY_FOR_LAUNCH_QA',
  'READY_FOR_META_DRAFT',
  'META_DRAFT_CREATED',
  'SCHEDULED',
  'LIVE',
] as const;
type WalkedState = (typeof STATE_ORDER)[number];

const STATE_LABELS_DE: Readonly<Record<WalkedState, string>> = {
  IDEA: 'Idee',
  PROPOSED: 'Vorgeschlagen',
  STRATEGY_REVIEW: 'Strategie in Prüfung',
  STRATEGY_APPROVED: 'Strategie freigegeben',
  ASSET_GENERATION: 'Assets werden erzeugt',
  ASSET_REVIEW: 'Assets in Prüfung',
  TEST_PLAN_REVIEW: 'Testplan in Prüfung',
  READY_FOR_LAUNCH_QA: 'Bereit für Launch-QA',
  READY_FOR_META_DRAFT: 'Bereit für Meta-Entwurf',
  META_DRAFT_CREATED: 'Meta-Entwurf erstellt (pausiert)',
  SCHEDULED: 'Geplant',
  LIVE: 'Live',
};

/**
 * The campaign's state, read off the header's status badge.
 *
 * The badge rather than the header text: the header also carries the next
 * action, whose German copy legitimately mentions other states ("Live-Schaltung
 * blockiert"), and a substring match there would report a paused draft as live.
 */
async function currentState(page: Page): Promise<WalkedState> {
  const badge = page.locator(
    '[data-campaign-header] [data-status-kind="campaign"][data-status-state]',
  );
  await expect(badge).toHaveCount(1);
  const value = await badge.getAttribute('data-status-state');
  const state = STATE_ORDER.find((candidate) => candidate === value);
  if (!state) throw new Error(`Unbekannter Kampagnenstatus: ${value}`);
  return state;
}

/** Grants an approval on the open tab. Idempotent: approving twice is one act. */
async function approve(page: Page, kindDe: string): Promise<void> {
  await waitForConsoleReady(page);
  const button = page.getByRole('button', { name: /^(Freigeben|Erneut freigeben)$/ }).first();
  await expect(button, `Die Freigabe „${kindDe}" wird nicht angeboten.`).toBeEnabled();
  await button.click();
  await expect(page.getByText(`Freigabe „${kindDe}" gespeichert.`).first()).toBeVisible();
  await expect(page.locator('[data-approval-invalid]')).toHaveCount(0);
}

/**
 * Performs every state change the tab offers until the campaign has reached
 * `to`, and asserts it is already at or past `to` when nothing is offered.
 *
 * A tab offers exactly one step at a time — the strategy tab, for instance,
 * offers `STRATEGY_APPROVED` first and `ASSET_GENERATION` only afterwards — so
 * reaching a target can take more than one press.
 */
async function advanceTo(page: Page, to: WalkedState): Promise<void> {
  const target = STATE_ORDER.indexOf(to);
  await waitForConsoleReady(page);
  let state = await currentState(page);

  for (let press = 0; press < STATE_ORDER.length && STATE_ORDER.indexOf(state) < target; press += 1) {
    const button = page.locator('[data-advance-action]');
    await expect(
      button,
      `Auf dem Weg nach „${STATE_LABELS_DE[to]}" bietet der Reiter bei Status „${STATE_LABELS_DE[state]}" keinen Schritt an.`,
    ).toHaveCount(1);

    const offered = await button.getAttribute('data-advance-action');
    expect(
      STATE_ORDER.indexOf(offered as WalkedState),
      `Der angebotene Schritt „${offered}" führt nicht in Richtung „${STATE_LABELS_DE[to]}".`,
    ).toBeGreaterThan(STATE_ORDER.indexOf(state));

    await expect(button).toBeEnabled();
    await button.click();

    /* The confirmation banner sits inside the panel that the transition itself
       removes, so the header's status badge is the authority. */
    await page.reload();
    await waitForConsoleReady(page);
    const next = await currentState(page);
    expect(
      STATE_ORDER.indexOf(next),
      `Der Schritt nach „${offered}" hat den Status nicht verändert.`,
    ).toBeGreaterThan(STATE_ORDER.indexOf(state));
    state = next;
  }

  expect(
    STATE_ORDER.indexOf(state),
    `Die Kampagne hat „${STATE_LABELS_DE[to]}" nicht erreicht.`,
  ).toBeGreaterThanOrEqual(target);
}

test.describe('Die vollständige Kette', () => {
  /* Two browser contexts, a console and a funnel visit, plus a walk through
     eight console tabs and a seven-step form. */
  test.setTimeout(240_000);

  test('von der Kampagnenidee bis zur bestätigten Skalierung', async ({
    operator,
    openCampaign,
    visitorContext,
    visitor,
  }) => {
    /* ---- 1. the operator signs in ---------------------------------- */
    await operator.goto('/heute');
    await expect(operator).not.toHaveURL(/\/login/);
    await expect(operator.getByRole('heading', { level: 1 })).toBeVisible();

    /* ---- 2. historical data is visible ----------------------------- */
    await operator.goto('/performance');
    await expect(operator.getByRole('heading', { level: 1, name: 'Performance' })).toBeVisible();
    const delivery = operator.getByRole('region', { name: 'Auslieferung' });
    await expect(delivery).toContainText('Spend');
    await expect(delivery.locator('[data-am-numeric]').first()).not.toBeEmpty();
    await expect(operator.getByRole('region', { name: 'Vertrieb und Umsatz' })).toContainText(
      'Umsatz',
    );
    /* CRM figures lag the period, and the page says so instead of pretending. */
    await expect(operator.getByRole('region', { name: 'Vertrieb und Umsatz' })).toContainText(
      'laufen dem Zeitraum hinterher',
    );

    /* ---- 3. a campaign proposal exists ----------------------------- */
    const campaignId = await openCampaign(CAMPAIGNS.strategyReview, 'strategie');
    await expect(operator.locator('[data-campaign-header]')).toContainText(
      CAMPAIGNS.strategyReview,
    );

    /* ---- 4. angle, offer and hypothesis are reviewable -------------- */
    await expect(operator.getByRole('region', { name: 'Angle' })).toContainText(
      'Nachfolge planen, bevor sie drängt',
    );
    await expect(operator.getByRole('region', { name: 'Offer' })).toContainText(
      'Strategiegespräch',
    );
    await expect(
      operator.getByRole('region', { name: 'Kernbotschaft und Hypothese' }),
    ).toContainText('Kosten je qualifiziertem VQ sinken');
    await expect(
      operator.getByRole('region', { name: 'Claims' }).locator('[data-claim-confidence]'),
    ).not.toHaveCount(0);

    /* ---- 5. six creatives ------------------------------------------ */
    await operator.goto(`/kampagnen/${campaignId}/creatives`);
    await expect(
      operator.locator('[data-creative-key]'),
      'Der Vorschlag enthält nicht sechs Creative-Konzepte.',
    ).toHaveCount(6);
    for (const name of CREATIVE_CONCEPT_NAMES) {
      await expect(operator.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await expect(operator.locator('[data-diversity-blocked="false"]')).toBeVisible();

    /* ---- 6. two multi-step forms plus one further variant ----------- */
    await operator.goto(`/kampagnen/${campaignId}/funnel`);
    await expect(operator.locator('[data-funnel-kind="MULTI_STEP_FORM"]')).toHaveCount(2);
    await expect(operator.locator('[data-funnel-kind]')).toHaveCount(3);
    await expect(operator.getByText(FUNNEL_PROPOSAL_NAMES.formSix)).toBeVisible();
    await expect(operator.getByText(FUNNEL_PROPOSAL_NAMES.formFour)).toBeVisible();
    await expect(operator.getByText(FUNNEL_PROPOSAL_NAMES.landingPage)).toBeVisible();

    /* ---- 7. the operator edits a question … ------------------------ */
    await operator.goto(`/builder/form/${PUBLISHED_FORM_VERSION_ID}`);
    await expect(operator.getByText('Veröffentlichte Version — schreibgeschützt')).toBeVisible();
    const publishedTitle = await operator.getByLabel('Überschrift').inputValue();
    await waitForInteractive(operator.getByRole('button', { name: 'Versionen' }));
    await operator.getByRole('button', { name: 'Als neuen Entwurf bearbeiten' }).click();

    /* ---- 8. … and a new form version is created -------------------- */
    await expect(
      operator,
      'Die Bearbeitung ist auf der veröffentlichten Version gelandet.',
    ).not.toHaveURL(new RegExp(PUBLISHED_FORM_VERSION_ID));
    await expect(operator).toHaveURL(/\/builder\/form\/[0-9a-f-]{36}$/);

    const editedTitle = `${publishedTitle} (Testlauf)`;
    await operator.getByLabel('Überschrift').fill(editedTitle);
    await operator.getByRole('button', { name: 'Entwurf speichern' }).click();
    await expect(operator.getByText(/Entwurf \d+ gespeichert\./).first()).toBeVisible();

    /* The published one is untouched — that is what the running experiment
       depends on. */
    await operator.goto(`/builder/form/${PUBLISHED_FORM_VERSION_ID}`);
    await expect(
      operator.getByLabel('Überschrift'),
      'Die veröffentlichte Formularversion wurde verändert.',
    ).toHaveValue(publishedTitle);

    /* ---- 9. strategy, assets and test plan are approved ------------- */
    await operator.goto(`/kampagnen/${campaignId}/strategie`);
    await approve(operator, APPROVAL_LABELS_DE.STRATEGY);
    await advanceTo(operator, 'ASSET_GENERATION');

    await operator.goto(`/kampagnen/${campaignId}/creatives`);
    await waitForConsoleReady(operator);
    for (const key of CREATIVE_KEYS) {
      const card = operator.locator(`[data-creative-key="${key}"]`);
      /* Retried on the effect rather than clicked once: the page streams, so
         the grid can still be un-hydrated while the shell above it answers, and
         a click into that window is swallowed without any actionability check
         noticing. Approving twice is the same act, so a retry costs nothing. */
      await expect(async () => {
        const approveButton = card.getByRole('button', { name: 'Creative freigeben' });
        if (await approveButton.isVisible()) await approveButton.click();
        await expect(card, `Creative „${key}" wurde nicht freigegeben.`).toHaveAttribute(
          'data-review-state',
          'APPROVED',
          { timeout: 2_000 },
        );
      }).toPass({ timeout: 30_000 });
    }
    await expect(
      operator.locator('[data-creative-key][data-review-state="APPROVED"]'),
      'Es sind nicht genug Creatives freigegeben.',
    ).toHaveCount(6);
    await expect(operator.locator('[data-asset-gate-blocked]')).toHaveCount(0);
    await approve(operator, APPROVAL_LABELS_DE.ASSETS);
    await advanceTo(operator, 'TEST_PLAN_REVIEW');

    await operator.goto(`/kampagnen/${campaignId}/testplan`);
    await approve(operator, APPROVAL_LABELS_DE.TEST_PLAN);
    await advanceTo(operator, 'READY_FOR_LAUNCH_QA');

    /* ---- 10. launch QA runs ---------------------------------------- */
    await operator.goto(`/kampagnen/${campaignId}/launch-qa`);
    await expect(operator.locator('[data-launch-check]')).toHaveCount(20);
    await expect(operator.locator('[data-gate="gate-meta-draft"]')).toHaveAttribute(
      'data-gate-open',
      'true',
    );
    /* The live gate stays shut: the HubSpot mapping and the Meta permissions
       are still waiting on the customer. */
    await expect(operator.locator('[data-gate="gate-go-live"]')).toHaveAttribute(
      'data-gate-open',
      'false',
    );
    await expect(
      operator.locator('[data-launch-check="hubspot_mapping_complete"]'),
    ).toHaveAttribute('data-launch-check-status', 'AWAITING_EXTERNAL_INPUT');
    await expect(operator.locator('[data-launch-check="meta_permissions_valid"]')).toHaveAttribute(
      'data-launch-check-status',
      'AWAITING_EXTERNAL_INPUT',
    );

    /* ---- 11. a Meta draft is created, paused ------------------------ */
    /*
     * DEFECT — see the report.
     *
     * The paused draft must be reachable *without* the publication approval:
     * `REQUIRED_APPROVALS_FOR_STATE` asks only for STRATEGY, ASSETS and
     * TEST_PLAN for `READY_FOR_META_DRAFT` and `META_DRAFT_CREATED`, and the
     * panel's own description says the publication approval only decides
     * whether the draft ever leaves the paused state. But the Launch-QA tab
     * renders its advance inside the PUBLISH approval panel, whose
     * `advanceBlocked = !status.valid` disables the button until publication is
     * approved — so the whole paused-draft workflow, the one thing that is
     * supposed to work before any credential exists, cannot be performed.
     *
     * Asserted softly: the failure is recorded with its reason, and the rest of
     * the chain below is still walked instead of being lost to an early exit.
     */
    await waitForConsoleReady(operator);
    if ((await currentState(operator)) === 'READY_FOR_LAUNCH_QA') {
      const draftAdvance = operator.locator('[data-advance-action="READY_FOR_META_DRAFT"]');
      await expect(draftAdvance).toBeVisible();
      await expect
        .soft(
          draftAdvance,
          'Der pausierte Meta-Entwurf verlangt die Veröffentlichungsfreigabe, obwohl REQUIRED_APPROVALS_FOR_STATE sie für diesen Schritt nicht fordert.',
        )
        .toBeEnabled();

      if (await draftAdvance.isDisabled()) {
        /* Work around the defect so the chain can continue. The approval is not
           a requirement of this step — granting it is the deviation, not the
           test. */
        await approve(operator, APPROVAL_LABELS_DE.PUBLISH);
      }
    }

    await advanceTo(operator, 'READY_FOR_META_DRAFT');

    /*
     * The step that reaches Meta.
     *
     * With `EXTERNAL_WRITES_ENABLED=false` the console refuses to move the
     * campaign into `META_DRAFT_CREATED`, because that state asserts something
     * about Meta that no provider has confirmed. What can be driven through the
     * UI is therefore everything up to the send: the operator sees the exact
     * payload — a campaign created `PAUSED` — confirms it, and gets a dry run
     * that says plainly that nothing was created and the status did not move.
     * The paused draft itself is asserted below on the fixture campaign that
     * has one. See the report.
     */
    await operator.goto(`/kampagnen/${campaignId}/launch-qa`);
    await waitForConsoleReady(operator);
    const metaAdvance = operator.locator('[data-advance-action="META_DRAFT_CREATED"]');
    await expect(metaAdvance).toBeEnabled();
    await metaAdvance.click();

    const metaDialog = operator.getByRole('alertdialog');
    await expect(metaDialog).toBeVisible();
    await expect(metaDialog, 'Die Vorschau zeigt den Entwurf nicht als pausiert.').toContainText(
      'PAUSED',
    );
    await expect(metaDialog.getByRole('button', { name: 'An Meta senden' })).toBeDisabled();
    await metaDialog.getByRole('textbox').fill('AUSFÜHREN');
    await metaDialog.getByRole('button', { name: 'An Meta senden' }).click();

    await expect(operator.locator('[data-dry-run="true"]')).toContainText(
      'Dry-Run – nicht ausgeführt',
    );
    expect(
      await currentState(operator),
      'Ein Dry-Run hat den Kampagnenstatus verändert.',
    ).toBe('READY_FOR_META_DRAFT');

    /* The campaign that does have a paused draft shows what one looks like:
       the reality is the paused draft, never a live campaign. */
    await openCampaign(CAMPAIGNS.metaDraft, 'strategie');
    await expect(
      operator.locator('[data-campaign-header]'),
      'Der Entwurf wird nicht als pausiert ausgewiesen.',
    ).toHaveAttribute('data-reality', 'META_DRAFT_PAUSED');
    await expect(operator.locator('[data-reality-banner="META_DRAFT_PAUSED"]')).toBeVisible();

    await openCampaign(CAMPAIGNS.metaDraft, 'versionen');
    const metaCommand = operator.locator('[data-audit-action="meta.command_requested"]');
    await expect(metaCommand).toContainText('Pausierter Meta-Entwurf angefordert.');
    await expect(metaCommand).toContainText('CREATE_DRAFT_CAMPAIGN');
    await expect(metaCommand, 'Der Entwurf wurde nicht pausiert angelegt.').toContainText('PAUSED');

    /* And going live is still refused, because nothing external is connected. */
    await openCampaign(CAMPAIGNS.metaDraft, 'launch-qa');
    await expect(operator.locator('[data-gate="gate-go-live"]')).toHaveAttribute(
      'data-gate-open',
      'false',
    );
    await expect(
      operator.locator('[data-advance-action="LIVE"]:not([disabled])'),
      'Die Live-Schaltung war ohne verbundene Provider auslösbar.',
    ).toHaveCount(0);

    /* ---- 12. a visitor clicks a creative ---------------------------- */
    const recorder = new SubmitRecorder(visitor);
    const form = new FormDriver(visitor);
    const adUrl = launchUrlFor(
      FUNNEL_SLUG,
      {
        funnel_id: FUNNEL_FIXTURE_IDS.formFunnelId,
        experiment_id: FUNNEL_FIXTURE_IDS.experimentId,
      },
      { marketing: { utm_source: 'facebook', utm_medium: 'paid_social', fbclid: 'e2e-journey' } },
    );
    await visitor.goto(adUrl);

    /* ---- 13. the visitor gets a stable arm -------------------------- */
    const arm = await form.arm();
    await visitor.reload();
    expect((await form.arm()).armId, 'Der Arm wechselte zwischen zwei Aufrufen.').toBe(arm.armId);
    const secondTab = await visitorContext.newPage();
    const secondForm = new FormDriver(secondTab);
    await secondForm.open();
    expect((await secondForm.arm()).armId).toBe(arm.armId);
    await secondTab.close();

    /* The signed launch token is carried into the visit, so the events that
       follow can be resolved back to what was actually published. */
    const cookies = await visitorContext.cookies(FUNNEL_URL);
    expect(cookies.find((cookie) => cookie.name === 'am_t')?.httpOnly).toBe(true);

    /* ---- 14.–16. five questions, postcode, contact and consent ------ */
    await form.start();
    await form.answerQuestions();
    await form.fillPostcode();
    await form.next();
    await form.fillContact();
    await expect(form.consentCheckbox()).toBeChecked();

    /* ---- 17.–18. several submits, exactly one submission ------------ */
    await form.submit(5);
    await form.expectAnalysisResult();
    const submissionId = await recorder.expectExactlyOneSubmission(5);
    expect(submissionId).toMatch(/^[0-9a-f-]{36}$/);

    /* ---- 19.–21. HubSpot fails, the lead survives, a retry is offered  */
    await openCampaign(CAMPAIGNS.live, 'leads-sales');
    await waitForConsoleReady(operator);
    const failed = operator.locator('[data-sync-status="FAILED_RETRYING"]');
    await expect(failed.first(), 'Kein fehlgeschlagener HubSpot-Sync im Datensatz.').toBeVisible();
    await expect(failed.first()).toContainText('429');
    const leadCountBefore = await operator.locator('[data-lead]').count();

    await failed.first().getByRole('button', { name: 'Erneut übertragen' }).click();
    /* With writes disabled the retry is prepared and shown as a dry run — the
       honest outcome, and never rendered as a successful sync. */
    await expect(operator.locator('[data-dry-run="true"]')).toContainText(
      'Dry-Run – nicht ausgeführt',
    );
    await operator.reload();
    expect(
      await operator.locator('[data-lead]').count(),
      'Der Lead ist beim Wiederholungsversuch verloren gegangen.',
    ).toBe(leadCountBefore);

    /* The contact-level and the opportunity-level sync are both in the outbox,
       each with its own deduplication id. */
    await operator.goto('/integrationen/outbox');
    await expect(operator.getByText('contact.upsert')).toBeVisible();
    await expect(operator.getByText('deal.update')).toBeVisible();

    /* ---- 22.–25. VQ scheduled, attended, qualified, closed won ------ */
    await openCampaign(CAMPAIGNS.live, 'leads-sales');
    for (const stage of ['vq_scheduled', 'vq_attended', 'qualified_vq', 'opportunities', 'closed_won']) {
      const row = operator.locator(`[data-crm-stage="${stage}"]`);
      await expect(row, `Die CRM-Stufe „${stage}" fehlt.`).toBeVisible();
      await expect(row.locator('[data-am-rate-basis]')).toContainText('/');
    }
    await expect(operator.locator('[data-crm-stage="vq_no_show"]')).toBeVisible();
    await expect(operator.locator('[data-crm-stage="closed_lost"]')).toBeVisible();

    /* ---- 26. revenue against the right campaign and variant --------- */
    const revenue = operator.getByText('Attribuierter Umsatz').locator('..');
    await expect(revenue).toContainText('€');
    await openCampaign(CAMPAIGNS.strategyReview, 'leads-sales');
    await expect(
      operator.getByText('Noch keine Leads.'),
      'Eine Kampagne ohne Auslieferung zeigt fremden Umsatz.',
    ).toBeVisible();

    await openCampaign(CAMPAIGNS.live, 'live-performance');
    for (const name of Object.values(FUNNEL_PROPOSAL_NAMES)) {
      await expect(
        operator.getByText(name).first(),
        `Der Funnelarm „${name}" fehlt in der Aufschlüsselung.`,
      ).toBeVisible();
    }

    /* ---- 27. the Meta outcome is delivered deduplicated ------------- */
    await operator.goto('/integrationen/outbox');
    await waitForConsoleReady(operator);
    const purchase = operator.locator(
      '[data-outbox-row="stage:6b0d3e82-5a17-4c94-8f26-1d7e9b0a3c58:CLOSED_WON:4"]',
    );
    await expect(purchase).toContainText('Purchase');
    await purchase.getByRole('button', { name: 'Erneut senden' }).click();
    const dialog = operator.getByRole('alertdialog');
    await expect(
      dialog,
      'Die Wiederholung erklärt die Deduplizierung nicht.',
    ).toContainText('Durch die Deduplizierungs-ID entsteht beim Anbieter kein zweites Ereignis.');
    await dialog.getByRole('button', { name: 'Erneut senden' }).click();
    await expect(operator.locator('[data-dry-run="true"]')).toContainText(
      'Dry-Run – nicht ausgeführt',
    );
    /* The event id itself is the dedup key: one business event, one row. */
    await operator.reload();
    await expect(purchase).toHaveCount(1);

    /* ---- 28.–30. a justified scale recommendation, confirmed -------- */
    await openCampaign(CAMPAIGNS.live, 'empfehlungen');
    await waitForConsoleReady(operator);
    const scale = operator.locator('[data-recommendation-action="INCREASE_BUDGET"]');
    await expect(scale).toContainText('Tagesbudget um 20 % erhöhen');
    await expect(scale.locator('[data-fact-metric="cost_per_qualified_vq"]')).toBeVisible();
    await expect(scale.locator('[data-comparison-basis]')).toContainText('Verglichen mit');

    await scale.getByRole('button', { name: 'Annehmen und ausführen' }).click();
    const scaleDialog = operator.getByRole('alertdialog');
    await expect(scaleDialog).toContainText('"daily_budget"');
    await expect(scaleDialog.getByRole('button', { name: 'An Meta senden' })).toBeDisabled();
    await scaleDialog.getByRole('textbox').fill('AUSFÜHREN');
    await scaleDialog.getByRole('button', { name: 'An Meta senden' }).click();

    /*
     * The provider does not confirm, and the product does not pretend it did:
     * `EXTERNAL_WRITES_ENABLED=false`, so the command comes back as a dry run.
     * What the chain asserts here is the rule that makes a confirmation
     * meaningful at all — only `PROVIDER_CONFIRMED` renders as done, which the
     * already-confirmed pause command on the same screen demonstrates.
     */
    await expect(operator.locator('[data-dry-run="true"]')).toContainText(
      'campaign.update.daily_budget',
    );
    await expect(scale.locator('[data-execution-confirmed]')).toHaveCount(0);
    await expect(
      operator.locator('[data-recommendation-action="PAUSE_CREATIVE"] [data-execution-confirmed]'),
    ).toContainText('Die Änderung wurde vom Provider bestätigt');

    /* ---- 31. the audit log carries the whole chain ------------------ */
    await openCampaign(CAMPAIGNS.live, 'versionen');
    for (const action of [
      'campaign.created',
      'proposal.generated',
      'approval.granted',
      'creative.approved',
      'launch_qa.evaluated',
      'meta.command_requested',
      'campaign.state_changed',
      'recommendation.generated',
    ]) {
      await expect(
        operator.locator(`[data-audit-action="${action}"]`),
        `Im Audit-Log der ausgelieferten Kampagne fehlt „${action}".`,
      ).toHaveCount(1);
    }
    await expect(operator.locator('[data-audit-action="meta.command_requested"]')).toContainText(
      'PAUSED',
    );
  });
});
