import { FIXTURE_IDS, POTENZIALANALYSE_FORM_SPEC } from '@am/funnel-schema';

/**
 * The deterministic dataset, named.
 *
 * Everything here is either imported from `@am/funnel-schema` (which the e2e
 * package depends on) or copied from a fixture module the package cannot import
 * — `apps/funnels/src/server/fixture-store.ts` and
 * `apps/console/src/server/campaign-fixtures.ts` both live inside an app. The
 * copies are ids and German UI copy, both of which are stable by construction:
 * a fixture that changes shape between runs is useless for E2E assertions, and
 * the fixture modules say so themselves.
 *
 * **The fixture stores are process-scoped.** They live in module scope in the
 * two Next servers and are re-seeded when a server restarts. Every test in this
 * suite is therefore written to be idempotent against *either* state: it asserts
 * relative changes ("a new draft version exists", "exactly one submission for
 * this attempt") rather than absolute counts of mutable collections, and it
 * never depends on a mutation made by another spec.
 */

/* -------------------------------------------------------------------------- */
/* Funnel runtime                                                              */
/* -------------------------------------------------------------------------- */

export const FUNNEL_SLUG = 'potenzialanalyse';
export const LANDING_SLUG = 'potenzialanalyse-handwerk';
export const HYBRID_SLUG = 'potenzialanalyse-kurz';

/** Mirrors `FIXTURE_FUNNEL_IDS` in `apps/funnels/src/server/fixture-store.ts`. */
export const FUNNEL_FIXTURE_IDS = {
  formFunnelId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1001',
  formFunnelVersionA: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1002',
  formFunnelVersionB: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1003',
  formVersionB: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1004',
  draftFunnelVersionId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1009',
  experimentId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1010',
  armControlId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1011',
  armVariantId: '2b6a4f10-0c1e-4d55-9a71-5f0a3c2d1012',
} as const;

/** The published form version served by the control arm. */
export const PUBLISHED_FORM_VERSION_ID = FIXTURE_IDS.formVersionId;
export const FORM_ID = FIXTURE_IDS.formId;

/**
 * The two experiment arms, told apart by their intro copy. A visitor's arm is a
 * pure function of their visitor id, so this is how a test reads back the arm it
 * was given without reaching into the store.
 */
export const ARMS = [
  {
    armId: FUNNEL_FIXTURE_IDS.armControlId,
    funnelVersionId: FUNNEL_FIXTURE_IDS.formFunnelVersionA,
    formVersionId: FIXTURE_IDS.formVersionId,
    headline: POTENZIALANALYSE_FORM_SPEC.intro.headline,
    ctaLabel: POTENZIALANALYSE_FORM_SPEC.intro.primaryCtaLabel,
  },
  {
    armId: FUNNEL_FIXTURE_IDS.armVariantId,
    funnelVersionId: FUNNEL_FIXTURE_IDS.formFunnelVersionB,
    formVersionId: FUNNEL_FIXTURE_IDS.formVersionB,
    headline: 'In zwei Minuten wissen Sie, ob sich Meta-Werbung für Sie rechnet',
    ctaLabel: 'Jetzt prüfen',
  },
] as const;

export type ArmFixture = (typeof ARMS)[number];

/* -------------------------------------------------------------------------- */
/* Console campaigns                                                           */
/* -------------------------------------------------------------------------- */

/** German names of the fixture campaigns, as the list renders them. */
export const CAMPAIGNS = {
  live: 'Potenzialanalyse Handwerk — Q3',
  metaDraft: 'Benchmark Metallbau — Pilot',
  assetReview: 'Auslastungslücke Elektro — Test 2',
  invalidatedApproval: 'Fenstermontage Förderung — Nachtrag',
  strategyReview: 'Nachfolge im Handwerk — Idee',
  paused: 'Sanitär Notdienst — Sommerwelle',
  completed: 'Dachsanierung Förderung — Q2',
} as const;

/** The six creative concepts every campaign proposal carries. */
export const CREATIVE_CONCEPT_NAMES = [
  'Der Monat ohne Anfragen',
  'Vierzehn Anfragen im Quartal',
  'Agentur oder eigener Kanal',
  'Was 42 Betriebe gezeigt haben',
  'Kein Budget für Experimente',
  'Mehr Reichweite ist das falsche Ziel',
] as const;

/** German approval labels, as `APPROVAL_KIND_LABELS_DE` renders them. */
export const APPROVAL_LABELS_DE = {
  STRATEGY: 'Strategie (Angle, Offer, Claims)',
  ASSETS: 'Creatives und Funnel',
  TEST_PLAN: 'Testplan und initiales Budget',
  PUBLISH: 'Veröffentlichung',
} as const;

/** The three funnel proposals: two multi-step forms plus one further variant. */
export const FUNNEL_PROPOSAL_NAMES = {
  formSix: 'Potenzialanalyse — sechs Fragen',
  formFour: 'Potenzialanalyse — vier Fragen',
  landingPage: 'Landingpage mit Direktkontakt',
} as const;
