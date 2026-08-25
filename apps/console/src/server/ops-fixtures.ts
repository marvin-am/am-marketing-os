import { getFeatureFlags, isProviderConfigured, resolveProviderMode } from '@am/config';
import {
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  DEFAULT_EXPERIMENT_THRESHOLDS,
  DEFAULT_RECOMMENDATION_CONFIG,
  DEFAULT_ROLE_BUDGET_LIMITS,
  UNCONFIGURED_RETENTION_POLICY,
  dryRun,
  rollUpHealth,
  type ConsentVersion,
  type FeatureFlags,
  type HealthCheck,
  type OutboxEvent,
  type Provider,
  type ProviderHealth,
  type RetentionPolicy,
  type Role,
  type RoleBudgetLimit,
} from '@am/domain';
import {
  FIXTURE_MAPPING,
  INCOMPLETE_FIXTURE_MAPPING,
  MAPPING_WIZARD_STEPS,
  canPublishMapping,
  checkHubspotHealth,
  createFixtureCrmSeed,
  createHubspotProvider,
  createInMemorySyncStore,
  mappingDocumentSchema,
  missingRequiredMappings,
  publishMapping as publishMappingDocument,
  reconcile,
  requiredMappingsComplete,
  runTestLead,
  validateMapping,
  type HubspotMappingDocument,
  type MappingWizardStepKey,
  type TestLeadResult,
} from '@am/hubspot';
import {
  META_HEALTH_LABELS_DE,
  createMetaProvider,
  getMetaCredentials,
  runMetaHealthChecks,
} from '@am/meta';
import {
  META_WIZARD_STEP_KEYS,
  type ApprovalThresholds,
  type BrandTokens,
  type CredentialSlot,
  type FeatureFlagView,
  type HubspotMappingSnapshot,
  type HubspotStepView,
  type IntegrationsSnapshot,
  type LibrarySnapshot,
  type MappingVersionSummary,
  type MetaSetupSnapshot,
  type MetaWizardStep,
  type MetaWizardStepKey,
  type OpsPort,
  type OutboxRow,
  type OutboxSnapshot,
  type ProbeResultView,
  type ProviderCardData,
  type SettingsSnapshot,
  type TodaySnapshot,
  type WorkspaceMemberView,
} from './ops-port';

/**
 * Fixture implementation of `OpsPort`.
 *
 * It exists so Heute, Library, Integrationen and Einstellungen are walkable
 * **today**, before `@am/db` lands. It is a fixture and behaves like one: state
 * lives in module scope and is lost when the server process restarts. It is not
 * a cache, not a queue and not a stand-in for a database.
 *
 * What it models faithfully, because the screens assert it to the operator:
 *
 * - the Meta and HubSpot health panels come from the real probe functions in
 *   `@am/meta` / `@am/hubspot`, run against the packages' fixture providers, so
 *   `AWAITING_EXTERNAL_INPUT` shows up exactly where a credential is missing;
 * - a mapping is validated by `validateMapping` on every save, and publishing
 *   appends an immutable version rather than mutating the previous one;
 * - a write attempted while `EXTERNAL_WRITES_ENABLED=false` returns a
 *   `DryRunResult` and changes nothing;
 * - a fixture provider's acknowledgement is never reported as a provider
 *   confirmation.
 */

const FIXTURE_ANCHOR = '2026-08-25T07:30:00.000Z';

function iso(offsetMinutes: number): string {
  return new Date(Date.parse(FIXTURE_ANCHOR) + offsetMinutes * 60_000).toISOString();
}

function hash64(seed: string): string {
  // Deterministic, non-cryptographic filler for the 64-char payload hash column.
  let h = 0x811c9dc5;
  let out = '';
  for (let i = 0; out.length < 64; i += 1) {
    for (const ch of `${seed}:${i}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

/* -------------------------------------------------------------------------- */
/* Mutable fixture state                                                       */
/* -------------------------------------------------------------------------- */

interface FixtureState {
  mappingDraft: HubspotMappingDocument;
  mappingVersions: HubspotMappingDocument[];
  testLead: TestLeadResult | null;
  webhookTest: ProbeResultView | null;
  reconciliationTest: ProbeResultView | null;
  outbox: OutboxEvent[];
  members: WorkspaceMemberView[];
  roleBudgetLimits: Record<Role, RoleBudgetLimit>;
  approvalThresholds: ApprovalThresholds;
  experimentThresholds: typeof DEFAULT_EXPERIMENT_THRESHOLDS;
  recommendationConfig: typeof DEFAULT_RECOMMENDATION_CONFIG;
  attributionWindowDays: number;
  consentVersions: ConsentVersion[];
  retention: RetentionPolicy;
  brand: BrandTokens;
}

function initialOutbox(): OutboxEvent[] {
  const base = {
    provider_response_redacted: null,
    sent_at: null,
    submission_id: null,
    opportunity_id: null,
    dataset_id: null,
  } as const;

  return [
    {
      ...base,
      event_id: 'lead:9c1e6f0a-2b7d-4c31-8a15-4e0b7d2c9f61',
      destination: 'META_CAPI',
      event_name: 'Lead',
      event_time: iso(-95),
      payload_hash: hash64('capi-lead-1'),
      status: 'PENDING',
      attempt_count: 0,
      next_attempt_at: iso(2),
      last_error: null,
      created_at: iso(-95),
      campaign_id: '1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28',
    },
    {
      ...base,
      event_id: 'lead:7d2c9f61-4e0b-4a15-8c31-2b7d9c1e6f0a',
      destination: 'HUBSPOT',
      event_name: 'contact.upsert',
      event_time: iso(-240),
      payload_hash: hash64('hubspot-contact-1'),
      status: 'FAILED_RETRYING',
      attempt_count: 3,
      next_attempt_at: iso(18),
      last_error: 'HTTP 429 – Rate Limit erreicht. Wiederholung nach Backoff.',
      provider_response_redacted: {
        status: 429,
        category: 'RATE_LIMIT',
        message: 'You have reached your secondly limit.',
        email: '[redigiert]',
      },
      created_at: iso(-240),
      campaign_id: '1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28',
      submission_id: 'a1f0c6d2-3b74-4f8e-9d21-7c5b8e0a1f44',
    },
    {
      ...base,
      event_id: 'stage:6b0d3e82-5a17-4c94-8f26-1d7e9b0a3c58:CLOSED_WON:4',
      destination: 'META_CAPI',
      event_name: 'Purchase',
      event_time: iso(-2880),
      payload_hash: hash64('capi-purchase-1'),
      status: 'DEAD_LETTER',
      attempt_count: 8,
      next_attempt_at: null,
      last_error:
        'HTTP 400 – (#100) The parameter user_data is required for this event. Nach 8 Versuchen als Dead Letter abgelegt.',
      provider_response_redacted: {
        status: 400,
        error: { code: 100, type: 'OAuthException', message: 'The parameter user_data is required' },
        user_data: '[redigiert]',
      },
      created_at: iso(-2880),
      campaign_id: '1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28',
      opportunity_id: '6b0d3e82-5a17-4c94-8f26-1d7e9b0a3c58',
    },
    {
      ...base,
      event_id: 'stage:4e8a1c05-9b73-4d26-8017-2f5c6b3a9d84:VQ_PASSED:2',
      destination: 'META_CAPI',
      event_name: 'SubmitApplication',
      event_time: iso(-4320),
      payload_hash: hash64('capi-vq-1'),
      status: 'ACCEPTED',
      attempt_count: 1,
      next_attempt_at: null,
      last_error: null,
      sent_at: iso(-4318),
      provider_response_redacted: { events_received: 1, fbtrace_id: '[redigiert]' },
      created_at: iso(-4320),
      campaign_id: '2f5c8d01-3e74-4b26-9a8f-0d1e4c6b7f39',
      opportunity_id: '4e8a1c05-9b73-4d26-8017-2f5c6b3a9d84',
    },
    {
      ...base,
      event_id: 'deal:701:stage-sync:7',
      destination: 'HUBSPOT',
      event_name: 'deal.update',
      event_time: iso(-30),
      payload_hash: hash64('hubspot-deal-1'),
      status: 'PENDING',
      attempt_count: 0,
      next_attempt_at: iso(5),
      last_error: null,
      created_at: iso(-30),
      campaign_id: '2f5c8d01-3e74-4b26-9a8f-0d1e4c6b7f39',
    },
  ];
}

function initialMembers(): WorkspaceMemberView[] {
  return [
    {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Marvin Flenche',
      email: 'marvin@am-beratung.de',
      roles: ['ADMIN'],
      lastActiveAt: iso(-15),
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      displayName: 'Lea Brandt',
      email: 'lea.brandt@am-beratung.de',
      roles: ['MARKETING_LEAD'],
      lastActiveAt: iso(-180),
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      displayName: 'Jonas Reiter',
      email: 'jonas.reiter@am-beratung.de',
      roles: ['MARKETING_OPERATOR'],
      lastActiveAt: iso(-60),
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      displayName: 'Sarah Vogel',
      email: 'sarah.vogel@am-beratung.de',
      roles: ['REVOPS'],
      lastActiveAt: iso(-1440),
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      displayName: 'Daniel Kühn',
      email: 'daniel.kuehn@am-beratung.de',
      roles: ['EXECUTIVE'],
      lastActiveAt: iso(-4320),
    },
    {
      id: '66666666-6666-4666-8666-666666666666',
      displayName: 'Mira Schulz',
      email: 'mira.schulz@am-beratung.de',
      roles: ['CREATIVE_REVIEWER', 'VIEWER'],
      lastActiveAt: null,
    },
  ];
}

function initialConsentVersions(): ConsentVersion[] {
  return [
    {
      id: 'aaaaaaa1-0000-4000-8000-000000000001',
      version: 1,
      textDe:
        'Ich willige ein, dass A&M mich zu meiner Anfrage per E-Mail und Telefon kontaktiert. Die Einwilligung kann jederzeit mit Wirkung für die Zukunft widerrufen werden.',
      purposes: ['CONTACT'],
      privacyPolicyUrl: 'https://am-beratung.de/datenschutz',
      effectiveFrom: '2026-01-08T09:00:00.000Z',
      effectiveUntil: '2026-05-04T09:00:00.000Z',
    },
    {
      id: 'aaaaaaa1-0000-4000-8000-000000000002',
      version: 2,
      textDe:
        'Ich willige ein, dass A&M mich zu meiner Anfrage per E-Mail und Telefon kontaktiert und meine Angaben zur Auswertung der Anzeigenwirkung verwendet. Die Einwilligung kann jederzeit mit Wirkung für die Zukunft widerrufen werden.',
      purposes: ['CONTACT', 'AD_MEASUREMENT', 'ANALYTICS'],
      privacyPolicyUrl: 'https://am-beratung.de/datenschutz',
      effectiveFrom: '2026-05-04T09:00:00.000Z',
      effectiveUntil: null,
    },
  ];
}

function createState(): FixtureState {
  return {
    // The wizard opens on an incomplete draft: that is the honest starting
    // point before a customer portal has been described.
    mappingDraft: INCOMPLETE_FIXTURE_MAPPING,
    mappingVersions: [],
    testLead: null,
    webhookTest: null,
    reconciliationTest: null,
    outbox: initialOutbox(),
    members: initialMembers(),
    roleBudgetLimits: { ...DEFAULT_ROLE_BUDGET_LIMITS },
    approvalThresholds: {
      budgetScaleApprovalPct: 0.2,
      majorChangeApprovalPct: 0.5,
      dailyBudgetApprovalMinor: 20_000_00,
      currency: 'EUR',
    },
    experimentThresholds: { ...DEFAULT_EXPERIMENT_THRESHOLDS },
    recommendationConfig: { ...DEFAULT_RECOMMENDATION_CONFIG },
    attributionWindowDays: DEFAULT_ATTRIBUTION_WINDOW_DAYS,
    consentVersions: initialConsentVersions(),
    // Deliberately unconfigured: the product never invents a legal period.
    retention: { ...UNCONFIGURED_RETENTION_POLICY },
    brand: {
      primary: '#D7182A',
      foreground: '#111111',
      background: '#FFFFFF',
      accent: '#000000',
      logoAssetPath: null,
    },
  };
}

let state: FixtureState = createState();

/** Test seam: forget all fixture mutations. */
export function resetOpsFixtures(): void {
  state = createState();
}

/* -------------------------------------------------------------------------- */
/* Heute                                                                       */
/* -------------------------------------------------------------------------- */

function buildToday(flags: FeatureFlags): TodaySnapshot {
  const deadLetters = state.outbox.filter((e) => e.status === 'DEAD_LETTER').length;
  const retrying = state.outbox.filter((e) => e.status === 'FAILED_RETRYING').length;

  return {
    generatedAt: iso(0),
    activeCampaigns: [
      {
        id: '1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28',
        nameDe: 'Q3 Neukunden – Potenzialanalyse',
        state: 'LIVE',
        errorState: 'HUBSPOT_SYNC_FAILED',
        spendTodayMinor: 41_250,
        currency: 'EUR',
        leadsToday: 6,
        targetCostPerLeadMinor: 6_000,
        costPerLeadMinor: 6_875,
        maturity: 'PARTIAL',
        attributionCoverage: 0.82,
        href: '/kampagnen/1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28',
      },
      {
        id: '2f5c8d01-3e74-4b26-9a8f-0d1e4c6b7f39',
        nameDe: 'Sanierungsfahrplan – Bestandskunden',
        state: 'LIVE',
        errorState: null,
        spendTodayMinor: 18_900,
        currency: 'EUR',
        leadsToday: 2,
        targetCostPerLeadMinor: 8_000,
        costPerLeadMinor: 9_450,
        maturity: 'MATURE',
        attributionCoverage: 0.94,
        href: '/kampagnen/2f5c8d01-3e74-4b26-9a8f-0d1e4c6b7f39',
      },
      {
        id: '3a6d9e12-4f85-4c37-8b90-1e2f5d7c8a40',
        nameDe: 'Energieberatung Handwerk – Test 2',
        state: 'SCHEDULED',
        errorState: null,
        spendTodayMinor: 0,
        currency: 'EUR',
        leadsToday: 0,
        targetCostPerLeadMinor: 7_500,
        costPerLeadMinor: null,
        maturity: 'IMMATURE',
        attributionCoverage: null,
        href: '/kampagnen/3a6d9e12-4f85-4c37-8b90-1e2f5d7c8a40',
      },
    ],
    items: [
      {
        id: 'error-hubspot-sync',
        kind: 'ERROR',
        titleDe: `HubSpot-Sync fehlgeschlagen – ${retrying + deadLetters} Ereignis(se) betroffen`,
        detailDe:
          'Leads der Kampagne „Q3 Neukunden“ erreichen HubSpot nicht. Bis das behoben ist, sind VQ-, Abschluss- und Umsatzzahlen dieser Kampagne unvollständig.',
        href: '/integrationen/outbox',
        hrefLabelDe: 'Zur Fehlerliste',
        occurredAt: iso(-240),
        campaignNameDe: 'Q3 Neukunden – Potenzialanalyse',
        badge: { kind: 'campaignError', state: 'HUBSPOT_SYNC_FAILED' },
        severity: 'HIGH',
      },
      {
        id: 'error-capi-dead-letter',
        kind: 'ERROR',
        titleDe: 'Conversions-API: 1 Ereignis im Dead Letter',
        detailDe:
          'Ein Purchase-Ereignis wurde nach acht Versuchen abgelegt. Meta kennt diesen Abschluss nicht, die Optimierung rechnet ohne ihn.',
        href: '/integrationen/outbox',
        hrefLabelDe: 'Dead Letter öffnen',
        occurredAt: iso(-2880),
        campaignNameDe: 'Q3 Neukunden – Potenzialanalyse',
        badge: { kind: 'outbox', state: 'DEAD_LETTER' },
        severity: 'HIGH',
      },
      {
        id: 'error-tracking-consent',
        kind: 'ERROR',
        titleDe: 'Tracking: 12 Ereignisse ohne Einwilligung verworfen',
        detailDe:
          'Für 12 Sitzungen lag keine Einwilligung zur Anzeigenmessung vor. Das ist korrekt, senkt aber die Abdeckung der Zuordnung.',
        href: '/einstellungen#consent',
        hrefLabelDe: 'Consent-Versionen prüfen',
        occurredAt: iso(-600),
        campaignNameDe: null,
        badge: null,
        severity: 'MEDIUM',
      },
      {
        id: 'approval-assets-q3',
        kind: 'APPROVAL',
        titleDe: 'Creatives freigeben – Q3 Neukunden',
        detailDe:
          'Sechs Creatives warten seit gestern auf die inhaltliche Freigabe. Ohne sie bleibt der Testplan blockiert.',
        href: '/kampagnen/1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28/freigaben',
        hrefLabelDe: 'Freigabe öffnen',
        occurredAt: iso(-1200),
        campaignNameDe: 'Q3 Neukunden – Potenzialanalyse',
        badge: { kind: 'approval', state: 'PENDING' },
        severity: 'HIGH',
      },
      {
        id: 'approval-strategy-handwerk',
        kind: 'APPROVAL',
        titleDe: 'Strategie freigeben – Energieberatung Handwerk',
        detailDe: 'Angle, Offer und Claims liegen zur Freigabe vor.',
        href: '/kampagnen/3a6d9e12-4f85-4c37-8b90-1e2f5d7c8a40/freigaben',
        hrefLabelDe: 'Freigabe öffnen',
        occurredAt: iso(-2400),
        campaignNameDe: 'Energieberatung Handwerk – Test 2',
        badge: { kind: 'approval', state: 'PENDING' },
        severity: 'MEDIUM',
      },
      {
        id: 'recommendation-pause-creative',
        kind: 'RECOMMENDATION',
        titleDe: 'Creative pausieren – „Vergleich Alternative 2“',
        detailDe:
          '0 Leads bei 412,50 € Ausgaben, das entspricht dem 1,5-fachen des Ziel-CPL. Die Ausführung wird vorher im Detail angezeigt.',
        href: '/kampagnen/1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28/empfehlungen',
        hrefLabelDe: 'Empfehlung prüfen',
        occurredAt: iso(-300),
        campaignNameDe: 'Q3 Neukunden – Potenzialanalyse',
        badge: { kind: 'recommendation', state: 'OPEN' },
        severity: 'HIGH',
      },
      {
        id: 'recommendation-collect-more',
        kind: 'RECOMMENDATION',
        titleDe: 'Mehr Daten sammeln – Sanierungsfahrplan',
        detailDe:
          '3 von 20 benötigten Conversions pro Arm erreicht. Es wird kein Gewinner ausgerufen.',
        href: '/experimente',
        hrefLabelDe: 'Experiment öffnen',
        occurredAt: iso(-720),
        campaignNameDe: 'Sanierungsfahrplan – Bestandskunden',
        badge: { kind: 'recommendation', state: 'OPEN' },
        severity: 'LOW',
      },
      {
        id: 'budget-warning-q3',
        kind: 'BUDGET_WARNING',
        titleDe: 'Tagesbudget zu 92 % ausgeschöpft – Q3 Neukunden',
        detailDe:
          '412,50 € von 450,00 € Tagesbudget ausgegeben. Eine Erhöhung über 20 % benötigt eine Freigabe.',
        href: '/kampagnen/1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28',
        hrefLabelDe: 'Budget ansehen',
        occurredAt: iso(-45),
        campaignNameDe: 'Q3 Neukunden – Potenzialanalyse',
        badge: null,
        severity: 'MEDIUM',
      },
      {
        id: 'performance-warning-cpl',
        kind: 'PERFORMANCE_WARNING',
        titleDe: 'CPL 15 % über Ziel – Sanierungsfahrplan',
        detailDe:
          '94,50 € gegenüber 80,00 € Ziel-CPL, berechnet auf 2 Leads / 189,00 € der letzten 24 Stunden.',
        href: '/performance',
        hrefLabelDe: 'Performance ansehen',
        occurredAt: iso(-90),
        campaignNameDe: 'Sanierungsfahrplan – Bestandskunden',
        badge: null,
        severity: 'MEDIUM',
      },
      {
        id: 'matured-sanierungsfahrplan',
        kind: 'MATURED_RESULT',
        titleDe: 'Ergebnisse reif – Sanierungsfahrplan (Kohorte Juli)',
        detailDe:
          'Die CRM-Kohorte ist älter als 21 Tage. Ergebnis und Learning können jetzt festgehalten werden.',
        href: '/learnings',
        hrefLabelDe: 'Learning erstellen',
        occurredAt: iso(-1440),
        campaignNameDe: 'Sanierungsfahrplan – Bestandskunden',
        badge: null,
        severity: 'MEDIUM',
      },
      {
        id: 'proposal-fachkraefte',
        kind: 'PROPOSAL',
        titleDe: 'Neuer Kampagnenvorschlag: „Fachkräfte-Engpass“',
        detailDe: 'Drei Angles, zwei Offers, sechs Creative-Konzepte. Noch nicht gesichtet.',
        href: '/kampagnen?filter=vorschlaege',
        hrefLabelDe: 'Vorschlag ansehen',
        occurredAt: iso(-480),
        campaignNameDe: null,
        badge: { kind: 'campaign', state: 'PROPOSED' },
        severity: 'LOW',
      },
      {
        id: 'immature-q3',
        kind: 'IMMATURE_COHORT',
        titleDe: 'CRM-Kohorte noch unreif – Q3 Neukunden',
        detailDe:
          'Die ältesten Leads sind 9 von 21 benötigten Tagen alt. Skalierung bleibt gesperrt, bis die Kohorte reif ist.',
        href: '/kampagnen/1e4b7c90-2d63-4a15-8f7e-9c0d3b5a6e28',
        hrefLabelDe: 'Kampagne ansehen',
        occurredAt: iso(-12960),
        campaignNameDe: 'Q3 Neukunden – Potenzialanalyse',
        badge: null,
        severity: 'LOW',
      },
      ...(flags.externalWritesEnabled
        ? []
        : [
            {
              id: 'immature-writes-disabled',
              kind: 'IMMATURE_COHORT' as const,
              titleDe: 'Externe Schreibzugriffe sind deaktiviert',
              detailDe:
                'Empfehlungen können vorbereitet, aber nicht ausgeführt werden. Jede Ausführung endet als Dry-Run.',
              href: '/einstellungen#feature-flags',
              hrefLabelDe: 'Feature-Flags ansehen',
              occurredAt: iso(0),
              campaignNameDe: null,
              badge: null,
              severity: 'LOW' as const,
            },
          ]),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Library                                                                     */
/* -------------------------------------------------------------------------- */

function buildLibrary(): LibrarySnapshot {
  const claims: LibrarySnapshot['claims'] = [
    {
      id: 'claim-1',
      textDe: 'Durchschnittlich 38 % weniger Heizkosten nach Umsetzung des Sanierungsfahrplans.',
      confidence: 'FACT',
      evidence: {
        kindDe: 'Case Study',
        summaryDe: 'Auswertung von 14 abgeschlossenen Sanierungsprojekten 2024–2025.',
        sourceRefDe: 'case-study/muster-bau-2025',
        approved: true,
      },
      requiresHypothesisLabel: false,
    },
    {
      id: 'claim-2',
      textDe: 'Förderfähigkeit wird in der Erstberatung geprüft — ohne Vorabkosten.',
      confidence: 'FACT',
      evidence: {
        kindDe: 'Freigegebener Fakt',
        summaryDe: 'Leistungsbeschreibung Erstberatung, freigegeben durch die Geschäftsführung.',
        sourceRefDe: 'leistungen/erstberatung',
        approved: true,
      },
      requiresHypothesisLabel: false,
    },
    {
      id: 'claim-3',
      textDe: 'Handwerksbetriebe gewinnen mit einem Sanierungsfahrplan schneller Aufträge.',
      confidence: 'HYPOTHESIS',
      evidence: null,
      requiresHypothesisLabel: true,
    },
    {
      id: 'claim-4',
      textDe: 'Die Amortisation liegt typischerweise unter sieben Jahren.',
      confidence: 'INDICATION',
      evidence: {
        kindDe: 'Historische Performance',
        summaryDe: 'Median aus 9 Projekten; Datenbasis teilweise reif.',
        sourceRefDe: 'kampagne/2f5c8d01',
        approved: true,
      },
      requiresHypothesisLabel: false,
    },
  ];

  return {
    generatedAt: iso(0),
    creatives: [
      {
        id: 'creative-1',
        nameDe: 'Problem/Pain – „Heizkosten frisst die Marge“',
        principle: 'PROBLEM_PAIN',
        angleNameDe: 'Kostendruck im Bestand',
        offerNameDe: 'Kostenlose Potenzialanalyse',
        reviewState: 'APPROVED',
        hookDe: 'Ihre Heizkosten steigen schneller als Ihre Mieten.',
        bodyDe:
          'Wir zeigen in 20 Minuten, welche drei Maßnahmen in Ihrem Bestand den größten Hebel haben — und was davon gefördert wird.',
        renditions: [
          { aspectRatio: '1:1', width: 1080, height: 1080, status: 'READY', altTextDe: 'Diagramm steigender Heizkosten neben einem Mehrfamilienhaus.' },
          { aspectRatio: '4:5', width: 1080, height: 1350, status: 'READY', altTextDe: 'Diagramm steigender Heizkosten, hochformatig.' },
          { aspectRatio: '9:16', width: 1080, height: 1920, status: 'READY', altTextDe: 'Diagramm steigender Heizkosten, Story-Format.' },
        ],
        performance: {
          spendMinor: 214_500,
          currency: 'EUR',
          impressions: 84_210,
          leads: 34,
          costPerLeadMinor: 6_308,
          maturity: 'MATURE',
          attributionLevel: 'REVENUE_LINKED',
        },
        claims: [claims[0], claims[1]],
        href: '/library/creatives/creative-1',
      },
      {
        id: 'creative-2',
        nameDe: 'Konkretes Ergebnis – „38 % weniger“',
        principle: 'CONCRETE_RESULT',
        angleNameDe: 'Kostendruck im Bestand',
        offerNameDe: 'Kostenlose Potenzialanalyse',
        reviewState: 'APPROVED',
        hookDe: '38 % weniger Heizkosten — gerechnet, nicht geschätzt.',
        bodyDe:
          'Der Sanierungsfahrplan zeigt Maßnahme für Maßnahme, was sie kostet, was sie spart und was gefördert wird.',
        renditions: [
          { aspectRatio: '1:1', width: 1080, height: 1080, status: 'READY', altTextDe: 'Große Prozentzahl 38 % auf rotem Grund.' },
          { aspectRatio: '4:5', width: 1080, height: 1350, status: 'READY', altTextDe: 'Große Prozentzahl 38 %, hochformatig.' },
        ],
        performance: {
          spendMinor: 189_000,
          currency: 'EUR',
          impressions: 71_004,
          leads: 41,
          costPerLeadMinor: 4_610,
          maturity: 'MATURE',
          attributionLevel: 'REVENUE_LINKED',
        },
        claims: [claims[0]],
        href: '/library/creatives/creative-2',
      },
      {
        id: 'creative-3',
        nameDe: 'Vergleich – „Fahrplan statt Einzelmaßnahme“',
        principle: 'COMPARISON_ALTERNATIVE',
        angleNameDe: 'Reihenfolge schlägt Einzelmaßnahme',
        offerNameDe: 'Sanierungsfahrplan',
        reviewState: 'IN_REVIEW',
        hookDe: 'Neue Fenster zuerst? Das ist meistens die teuerste Reihenfolge.',
        bodyDe:
          'Wir vergleichen Ihre geplante Reihenfolge mit der wirtschaftlich optimalen — und benennen die Differenz in Euro.',
        renditions: [
          { aspectRatio: '1:1', width: 1080, height: 1080, status: 'READY', altTextDe: 'Zwei gegenübergestellte Maßnahmenreihenfolgen.' },
          { aspectRatio: '4:5', width: 1080, height: 1350, status: 'PENDING', altTextDe: null },
        ],
        performance: {
          spendMinor: 41_250,
          currency: 'EUR',
          impressions: 12_408,
          leads: 0,
          costPerLeadMinor: null,
          maturity: 'IMMATURE',
          attributionLevel: 'TRAFFIC_LINKED',
        },
        claims: [claims[2]],
        href: '/library/creatives/creative-3',
      },
      {
        id: 'creative-4',
        nameDe: 'Beleg/Case – „Muster Bau GmbH“',
        principle: 'PROOF_CASE_DATAPOINT',
        angleNameDe: 'Förderung sicher mitnehmen',
        offerNameDe: 'Sanierungsfahrplan',
        reviewState: 'APPROVED',
        hookDe: '14 Projekte, ein Muster: die Förderung wird fast immer zu spät beantragt.',
        bodyDe: 'Bei der Muster Bau GmbH waren es 41.000 € Förderung, die sonst verfallen wären.',
        renditions: [
          { aspectRatio: '1:1', width: 1080, height: 1080, status: 'READY', altTextDe: 'Zitatkarte mit Kennzahl 41.000 € Förderung.' },
          { aspectRatio: '4:5', width: 1080, height: 1350, status: 'READY', altTextDe: 'Zitatkarte, hochformatig.' },
        ],
        performance: {
          spendMinor: 97_400,
          currency: 'EUR',
          impressions: 33_190,
          leads: 12,
          costPerLeadMinor: 8_117,
          maturity: 'PARTIAL',
          attributionLevel: 'LEAD_LINKED',
        },
        claims: [claims[1], claims[3]],
        href: '/library/creatives/creative-4',
      },
      {
        id: 'creative-5',
        nameDe: 'Einwand – „Keine Zeit für Bürokratie“',
        principle: 'OBJECTION_HANDLING',
        angleNameDe: 'Förderung sicher mitnehmen',
        offerNameDe: 'Kostenlose Potenzialanalyse',
        reviewState: 'DRAFT',
        hookDe: '„Dafür habe ich keine Zeit.“ — Deshalb übernehmen wir den Antrag.',
        bodyDe: 'Sie liefern die Unterlagen, wir übernehmen Antrag, Fristen und Nachweise.',
        renditions: [
          { aspectRatio: '1:1', width: 1080, height: 1080, status: 'FAILED', altTextDe: null },
        ],
        performance: {
          spendMinor: 0,
          currency: 'EUR',
          impressions: 0,
          leads: 0,
          costPerLeadMinor: null,
          maturity: 'IMMATURE',
          attributionLevel: 'CREATIVE_ONLY',
        },
        claims: [],
        href: '/library/creatives/creative-5',
      },
      {
        id: 'creative-6',
        nameDe: 'Konträr – „Dämmen ist überbewertet“',
        principle: 'CONTRARIAN_INSIGHT',
        angleNameDe: 'Reihenfolge schlägt Einzelmaßnahme',
        offerNameDe: 'Sanierungsfahrplan',
        reviewState: 'REJECTED',
        hookDe: 'Dämmen ist überbewertet — zumindest als erster Schritt.',
        bodyDe: 'In zwei von drei Beständen bringt die Anlagentechnik zuerst mehr.',
        renditions: [
          { aspectRatio: '1:1', width: 1080, height: 1080, status: 'READY', altTextDe: 'Textkarte mit konträrer Aussage.' },
        ],
        performance: {
          spendMinor: 0,
          currency: 'EUR',
          impressions: 0,
          leads: 0,
          costPerLeadMinor: null,
          maturity: 'IMMATURE',
          attributionLevel: 'CREATIVE_ONLY',
        },
        claims: [claims[2]],
        href: '/library/creatives/creative-6',
      },
    ],
    angles: [
      {
        id: 'angle-1',
        nameDe: 'Kostendruck im Bestand',
        coreMessageDe:
          'Steigende Energiekosten fressen die Rendite im Bestand — planbar gegensteuern statt reagieren.',
        audienceDe: 'Eigentümer und Verwalter von 5–50 Wohneinheiten',
        versions: [
          { version: 1, status: 'ARCHIVED', summaryDe: 'Erstfassung, Fokus auf Heizkosten.', publishedAt: '2026-02-01T09:00:00.000Z' },
          { version: 2, status: 'PUBLISHED', summaryDe: 'Ergänzt um Mietrendite und Förderfrist.', publishedAt: '2026-06-12T09:00:00.000Z' },
        ],
        usedInCampaigns: 4,
        href: '/library/angles/angle-1',
      },
      {
        id: 'angle-2',
        nameDe: 'Reihenfolge schlägt Einzelmaßnahme',
        coreMessageDe:
          'Nicht die einzelne Maßnahme entscheidet über die Wirtschaftlichkeit, sondern ihre Reihenfolge.',
        audienceDe: 'Eigentümer mit konkretem Sanierungsvorhaben',
        versions: [
          { version: 1, status: 'PUBLISHED', summaryDe: 'Erstfassung.', publishedAt: '2026-07-20T09:00:00.000Z' },
          { version: 2, status: 'DRAFT', summaryDe: 'Entwurf mit Vergleichsrechnung.', publishedAt: null },
        ],
        usedInCampaigns: 2,
        href: '/library/angles/angle-2',
      },
      {
        id: 'angle-3',
        nameDe: 'Förderung sicher mitnehmen',
        coreMessageDe: 'Fördermittel verfallen an Fristen, nicht an fehlender Berechtigung.',
        audienceDe: 'Eigentümer und Handwerksbetriebe',
        versions: [
          { version: 1, status: 'PUBLISHED', summaryDe: 'Erstfassung.', publishedAt: '2026-03-15T09:00:00.000Z' },
        ],
        usedInCampaigns: 3,
        href: '/library/angles/angle-3',
      },
    ],
    offers: [
      {
        id: 'offer-1',
        nameDe: 'Kostenlose Potenzialanalyse',
        type: 'POTENTIAL_ANALYSIS',
        promiseDe: 'Drei priorisierte Maßnahmen mit Einsparung und Förderhöhe — in 20 Minuten.',
        effortPromiseDe: '20 Minuten',
        usedInCampaigns: 5,
        href: '/library/offers/offer-1',
      },
      {
        id: 'offer-2',
        nameDe: 'Sanierungsfahrplan',
        type: 'STRATEGY_CALL',
        promiseDe: 'Vollständiger Fahrplan inklusive Förderantrag und Zeitplan.',
        effortPromiseDe: '2 Termine',
        usedInCampaigns: 3,
        href: '/library/offers/offer-2',
      },
    ],
    claims,
    caseStudies: [
      {
        id: 'case-1',
        clientDe: 'Muster Bau GmbH',
        industryDe: 'Wohnungsbau',
        challengeDe:
          'Bestand mit 34 Wohneinheiten, Heizkosten dreimal in Folge gestiegen, keine belastbare Maßnahmenreihenfolge.',
        outcomeDe:
          'Sanierungsfahrplan umgesetzt, 41.000 € Förderung gesichert, Heizkosten im ersten vollen Jahr um 38 % gesenkt.',
        metrics: [
          { labelDe: 'Förderung', valueDe: '41.000 €' },
          { labelDe: 'Heizkosten', valueDe: '−38 %' },
          { labelDe: 'Umsetzungsdauer', valueDe: '11 Monate' },
        ],
        approved: true,
        usableInAds: true,
      },
      {
        id: 'case-2',
        clientDe: 'Hausverwaltung Nordlicht',
        industryDe: 'Immobilienverwaltung',
        challengeDe: 'Sieben Objekte, unterschiedliche Baujahre, kein einheitlicher Standard.',
        outcomeDe: 'Einheitlicher Maßnahmenkatalog, Förderquote von 21 % auf 34 % erhöht.',
        metrics: [{ labelDe: 'Förderquote', valueDe: '+13 Prozentpunkte' }],
        approved: true,
        usableInAds: false,
      },
    ],
    testimonials: [
      {
        id: 'testimonial-1',
        quoteDe:
          'Zum ersten Mal hatte ich eine Reihenfolge, die ich meinem Beirat erklären konnte — mit Zahlen.',
        authorDe: 'Thomas Krause, Geschäftsführer',
        companyDe: 'Muster Bau GmbH',
        approved: true,
        usableInAds: true,
      },
      {
        id: 'testimonial-2',
        quoteDe: 'Der Förderantrag war nach zwei Wochen durch. Allein hätten wir das nicht geschafft.',
        authorDe: 'Sabine Hoffmann, Verwaltung',
        companyDe: 'Hausverwaltung Nordlicht',
        approved: false,
        usableInAds: false,
      },
    ],
    faqs: [
      {
        id: 'faq-1',
        questionDe: 'Was kostet die Potenzialanalyse?',
        answerDe: 'Nichts. Die Erstberatung ist kostenfrei und unverbindlich.',
        approved: true,
      },
      {
        id: 'faq-2',
        questionDe: 'Wie lange dauert ein Sanierungsfahrplan?',
        answerDe: 'Von der Aufnahme bis zum fertigen Fahrplan üblicherweise vier bis sechs Wochen.',
        approved: true,
      },
      {
        id: 'faq-3',
        questionDe: 'Übernehmen Sie auch den Förderantrag?',
        answerDe: 'Ja, inklusive Fristenüberwachung und Verwendungsnachweis.',
        approved: false,
      },
    ],
    guardrails: [
      {
        id: 'guardrail-1',
        kindDe: 'Verbotener Begriff',
        pattern: 'garantiert',
        reasonDe: 'Eine Ersparnis darf nicht garantiert werden — sie hängt vom Objekt ab.',
        severity: 'BLOCK',
      },
      {
        id: 'guardrail-2',
        kindDe: 'Verbotene Aussage',
        pattern: 'Förderung sicher',
        reasonDe: 'Förderzusagen liegen bei der Bewilligungsstelle, nicht bei A&M.',
        severity: 'BLOCK',
      },
      {
        id: 'guardrail-3',
        kindDe: 'Stilregel',
        pattern: 'billig',
        reasonDe: 'Nicht markenkonform; „wirtschaftlich“ verwenden.',
        severity: 'WARN',
      },
      {
        id: 'guardrail-4',
        kindDe: 'Pflichthinweis',
        pattern: 'Einsparung',
        reasonDe: 'Jede Einsparungsangabe benötigt den Hinweis auf die Berechnungsgrundlage.',
        severity: 'WARN',
      },
    ],
    historicalCampaigns: [
      {
        id: 'hist-1',
        nameDe: 'Q2 Bestandshalter – Potenzialanalyse',
        periodDe: '01.04.2026 – 30.06.2026',
        spendMinor: 1_284_000,
        currency: 'EUR',
        attributionLevel: 'REVENUE_LINKED',
        attributionCoverage: 0.91,
        maturity: 'MATURE',
        confidence: 'FACT',
        outcomeDe:
          '187 Leads, 64 qualifizierte VQ, 11 Abschlüsse, 268.400 € Umsatz. CAC 1.167 €, ROAS 2,09×.',
        angleNameDe: 'Kostendruck im Bestand',
        offerNameDe: 'Kostenlose Potenzialanalyse',
        href: '/kampagnen/hist-1',
      },
      {
        id: 'hist-2',
        nameDe: 'Frühjahr Handwerk – Sanierungsfahrplan',
        periodDe: '10.02.2026 – 28.03.2026',
        spendMinor: 486_500,
        currency: 'EUR',
        attributionLevel: 'LEAD_LINKED',
        attributionCoverage: 0.58,
        maturity: 'PARTIAL',
        confidence: 'INDICATION',
        outcomeDe:
          '73 Leads, 19 qualifizierte VQ, Abschlussdaten unvollständig — die Umsatzzuordnung war zu diesem Zeitpunkt noch nicht aktiv.',
        angleNameDe: 'Förderung sicher mitnehmen',
        offerNameDe: 'Sanierungsfahrplan',
        href: '/kampagnen/hist-2',
      },
      {
        id: 'hist-3',
        nameDe: 'Testlauf Reihenfolge-Angle',
        periodDe: '05.01.2026 – 26.01.2026',
        spendMinor: 118_000,
        currency: 'EUR',
        attributionLevel: 'TRAFFIC_LINKED',
        attributionCoverage: null,
        maturity: 'IMMATURE',
        confidence: 'HYPOTHESIS',
        outcomeDe:
          'Nur Traffic zugeordnet: 4.108 Sitzungen, keine belastbare Lead-Zuordnung. Als Hypothese geführt.',
        angleNameDe: 'Reihenfolge schlägt Einzelmaßnahme',
        offerNameDe: null,
        href: '/kampagnen/hist-3',
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Provider health                                                             */
/* -------------------------------------------------------------------------- */

function simpleCheck(
  key: string,
  labelDe: string,
  status: HealthCheck['status'],
  detailDe: string,
  remediationDe: string | null,
  blocksLiveOnly = false,
): HealthCheck {
  return { key, labelDe, status, detailDe, checkedAt: iso(0), remediationDe, blocksLiveOnly };
}

function openAiHealth(): ProviderHealth {
  const configured = isProviderConfigured('OPENAI');
  const checks: HealthCheck[] = [
    simpleCheck(
      'openai.api_key',
      'API-Schlüssel hinterlegt',
      configured ? 'PASS' : 'AWAITING_EXTERNAL_INPUT',
      configured
        ? 'Ein OpenAI-Schlüssel ist konfiguriert.'
        : 'Es ist kein OpenAI-Schlüssel hinterlegt. Die Generierung läuft gegen den Fixture-Anbieter.',
      configured ? null : 'OPENAI_API_KEY hinterlegen.',
      true,
    ),
    simpleCheck(
      'openai.structured_output',
      'Strukturierte Ausgaben',
      'PASS',
      'Alle Prompts sind gegen ein JSON-Schema validiert. Freies Markup wird nie gespeichert oder ausgeliefert.',
      null,
    ),
    simpleCheck(
      'openai.budget',
      'Kostenbegrenzung',
      configured ? 'WARN' : 'AWAITING_EXTERNAL_INPUT',
      configured
        ? 'Es ist kein Monatslimit für Generierungskosten hinterlegt.'
        : 'Ohne Schlüssel entstehen keine Kosten.',
      configured ? 'Monatslimit in den Einstellungen festlegen.' : null,
    ),
  ];
  return {
    provider: 'OPENAI',
    state: configured ? 'CONNECTED' : 'FIXTURE',
    overall: rollUpHealth(checks),
    checks,
    checkedAt: iso(0),
  };
}

function supabaseHealth(): ProviderHealth {
  const configured = isProviderConfigured('SUPABASE');
  const checks: HealthCheck[] = [
    simpleCheck(
      'supabase.project',
      'Projekt erreichbar',
      configured ? 'PASS' : 'AWAITING_EXTERNAL_INPUT',
      configured
        ? 'Supabase-Projekt konfiguriert.'
        : 'Es ist kein Supabase-Projekt hinterlegt. Die Konsole läuft mit einer Demo-Sitzung gegen Fixtures.',
      configured ? null : 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY und DATABASE_URL hinterlegen.',
      true,
    ),
    simpleCheck(
      'supabase.rls',
      'Row Level Security',
      configured ? 'PASS' : 'AWAITING_EXTERNAL_INPUT',
      configured
        ? 'RLS ist für alle Tabellen aktiv.'
        : 'Ohne Projekt kann RLS nicht geprüft werden.',
      null,
      true,
    ),
    simpleCheck(
      'supabase.storage',
      'Storage-Buckets',
      configured ? 'PASS' : 'AWAITING_EXTERNAL_INPUT',
      configured ? 'Creative-Bucket vorhanden.' : 'Ohne Projekt existiert kein Bucket.',
      null,
      true,
    ),
  ];
  return {
    provider: 'SUPABASE',
    state: configured ? 'CONNECTED' : 'FIXTURE',
    overall: rollUpHealth(checks),
    checks,
    checkedAt: iso(0),
  };
}

async function metaHealth(flags: FeatureFlags): Promise<ProviderHealth> {
  const provider = createMetaProvider({ flags });
  return runMetaHealthChecks({
    provider,
    credentials: getMetaCredentials(),
    flags,
    now: iso(0),
  });
}

function hubspotProviderInstance(flags: FeatureFlags) {
  return createHubspotProvider({ flags, seed: createFixtureCrmSeed() });
}

async function hubspotHealth(flags: FeatureFlags): Promise<ProviderHealth> {
  const published = state.mappingVersions.at(-1) ?? null;
  const mapping = published ?? state.mappingDraft;
  return checkHubspotHealth(
    {
      mapping,
      flags,
      lastSuccessfulSyncAt: state.testLead?.status === 'PASS' ? state.testLead.finishedAt : null,
      webhookSubscription: {
        active: mapping.webhook.subscribedObjectTypes.length > 0,
        subscribedTypes: mapping.webhook.subscribedObjectTypes,
        secretConfigured: false,
      },
      testLead: state.testLead
        ? { status: state.testLead.status, at: state.testLead.finishedAt }
        : null,
    },
    { provider: hubspotProviderInstance(flags), now: () => iso(0) },
  );
}

/* -------------------------------------------------------------------------- */
/* Meta wizard                                                                 */
/* -------------------------------------------------------------------------- */

const META_STEP_DESCRIPTIONS_DE: Readonly<Record<MetaWizardStepKey, string>> = {
  'meta.app_connection':
    'Meta-App verbinden und Zugriffstoken hinterlegen. Ohne Token bleibt die Konsole im Fixture-Modus.',
  'meta.business': 'Business-Manager auswählen, aus dem Werbekonto, Seite und Dataset stammen.',
  'meta.ad_account': 'Werbekonto auswählen, in dem Entwürfe angelegt und Insights gelesen werden.',
  'meta.page_ig':
    'Facebook-Seite und optional das Instagram-Konto verknüpfen. Ohne Seite kann kein Creative angelegt werden.',
  'meta.pixel_dataset':
    'Pixel und optional ein separates Dataset für Down-Funnel-Ereignisse auswählen.',
  'meta.permissions': 'Die tatsächlich erteilten Berechtigungen prüfen — sie werden nie angenommen.',
  'meta.insights_read': 'Lesetest gegen die Insights-API über die letzten sieben Tage.',
  'meta.draft_test':
    'Entwurfsplan bauen und prüfen. Es wird nichts angelegt; alle Objekte wären pausiert.',
  'meta.capi_test':
    'Ein vollständig gehashtes Ereignispaar erzeugen und die Deduplizierung prüfen. Es wird nichts gesendet.',
  'meta.final_health':
    'Gesamtergebnis aller Prüfungen. Erst wenn hier nichts mehr offen ist, ist die Meta-Anbindung vollständig.',
};

const META_STEP_ENV_VARS: Readonly<Record<MetaWizardStepKey, string[]>> = {
  'meta.app_connection': ['META_APP_ID', 'META_APP_SECRET', 'META_ACCESS_TOKEN'],
  'meta.business': [],
  'meta.ad_account': ['META_AD_ACCOUNT_ID'],
  'meta.page_ig': ['META_PAGE_ID', 'META_INSTAGRAM_ACTOR_ID'],
  'meta.pixel_dataset': ['META_PIXEL_ID', 'META_DATASET_ID'],
  'meta.permissions': [],
  'meta.insights_read': [],
  'meta.draft_test': ['EXTERNAL_WRITES_ENABLED', 'META_MUTATIONS_ENABLED'],
  'meta.capi_test': ['EXTERNAL_WRITES_ENABLED', 'META_CAPI_ENABLED'],
  'meta.final_health': [],
};

function credentialSlots(mode: 'FIXTURE' | 'LIVE'): CredentialSlot[] {
  const credentials = getMetaCredentials();
  const slot = (
    labelDe: string,
    envVar: string,
    value: string | null,
    secret = false,
  ): CredentialSlot => ({
    labelDe,
    envVar,
    present: Boolean(value),
    // A secret is never rendered, and in fixture mode no id is presented as if
    // it came from Meta.
    displayValue: value && !secret && mode === 'LIVE' ? value : null,
    originDe: value
      ? secret
        ? `Hinterlegt über ${envVar} (wird nicht angezeigt).`
        : mode === 'LIVE'
          ? `Hinterlegt über ${envVar}.`
          : `Hinterlegt über ${envVar}; im Fixture-Modus nicht gegen Meta geprüft.`
      : `Nicht hinterlegt (${envVar}).`,
  });

  return [
    slot('App-ID', 'META_APP_ID', credentials.appId),
    slot('Zugriffstoken', 'META_ACCESS_TOKEN', credentials.accessToken, true),
    slot('Business-Manager-ID', 'META_BUSINESS_ID', credentials.businessId),
    slot('Werbekonto', 'META_AD_ACCOUNT_ID', credentials.adAccountId),
    slot('Facebook-Seite', 'META_PAGE_ID', credentials.pageId),
    slot('Instagram-Konto', 'META_INSTAGRAM_ACTOR_ID', credentials.instagramActorId),
    slot('Pixel', 'META_PIXEL_ID', credentials.pixelId),
    slot('Dataset', 'META_DATASET_ID', credentials.datasetId),
  ];
}

function toMetaSteps(health: ProviderHealth): MetaWizardStep[] {
  return META_WIZARD_STEP_KEYS.map((key, index) => {
    if (key === 'meta.final_health') {
      return {
        key,
        order: index + 1,
        labelDe: 'Abschließende Gesamtprüfung',
        descriptionDe: META_STEP_DESCRIPTIONS_DE[key],
        status: health.overall,
        check: null,
        requiredEnvVars: META_STEP_ENV_VARS[key],
      };
    }
    const check = health.checks.find((c) => c.key === key) ?? null;
    return {
      key,
      order: index + 1,
      labelDe: META_HEALTH_LABELS_DE[key],
      descriptionDe: META_STEP_DESCRIPTIONS_DE[key],
      status: check?.status ?? 'AWAITING_EXTERNAL_INPUT',
      check,
      requiredEnvVars: META_STEP_ENV_VARS[key],
    };
  });
}

async function buildMetaSetup(flags: FeatureFlags): Promise<MetaSetupSnapshot> {
  const mode = resolveProviderMode('META');
  const health = await metaHealth(flags);
  return {
    generatedAt: iso(0),
    mode,
    fixtureNoticeDe:
      mode === 'FIXTURE'
        ? 'Der Assistent läuft gegen den Meta-Fixture-Anbieter. Es besteht keine Verbindung zu Meta, alle angezeigten Strukturen und Zahlen stammen aus dem Testdatensatz. Sobald Zugangsdaten hinterlegt sind, laufen dieselben Prüfungen gegen das echte Konto.'
        : null,
    health,
    steps: toMetaSteps(health),
    credentials: credentialSlots(mode),
    flags,
  };
}

/* -------------------------------------------------------------------------- */
/* HubSpot mapping wizard                                                      */
/* -------------------------------------------------------------------------- */

function labelList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'keine';
}

function stepSummary(step: MappingWizardStepKey, m: HubspotMappingDocument): string[] {
  switch (step) {
    case 'objects':
      return [
        `Kontakte: ${m.objects.contact}`,
        `Unternehmen: ${m.objects.company}`,
        `Deals: ${m.objects.deal}`,
      ];
    case 'contact_identifier':
      return [
        `Identifikator: ${m.contactIdentifier.property} (${m.contactIdentifier.normalization})`,
        `A&M-Personen-ID: ${m.contactIdentifier.personIdProperty ?? 'nicht hinterlegt'}`,
        `Lead-Quelle: ${m.contactIdentifier.leadSourceProperty ?? 'nicht hinterlegt'}`,
      ];
    case 'company_rule':
      return [
        `Regel: ${m.company.mode}`,
        `Domain-Eigenschaft: ${m.company.domainProperty}`,
        `Verknüpfung Kontakt → Unternehmen: ${m.company.associateContactToCompany ? 'ja' : 'nein'}`,
      ];
    case 'pipeline':
      return [
        `Pipeline: ${m.pipeline.pipelineLabel ?? m.pipeline.pipelineId ?? 'nicht ausgewählt'}`,
        `Start-Stage: ${m.pipeline.defaultStageId ?? 'nicht ausgewählt'}`,
        `Stage-Eigenschaft: ${m.pipeline.stageProperty}`,
      ];
    case 'deal_trigger':
      return [
        `Auslöser: ${m.dealCreation.trigger}`,
        `Modus: ${m.dealCreation.mode}`,
      ];
    case 'deal_identity':
      return [
        `Deal-Name: ${m.dealCreation.nameTemplate}`,
        `Opportunity-ID: ${m.dealCreation.opportunityIdProperty ?? 'nicht hinterlegt'}`,
        `Submission-ID: ${m.dealCreation.submissionIdProperty ?? 'nicht hinterlegt'}`,
      ];
    case 'stage_events':
      return m.stageEvents.length === 0
        ? ['Keine Stage-Regel hinterlegt.']
        : m.stageEvents.map((r) => `${r.stageLabel ?? r.stageId} → ${r.event}`);
    case 'property_value_events':
      return m.propertyValueEvents.length === 0
        ? ['Keine Wertregel hinterlegt.']
        : m.propertyValueEvents.map(
            (r) => `${r.property} ${r.operator} ${labelList(r.values)} → ${r.event}`,
          );
    case 'revenue':
      return [
        `Betrag: ${m.revenue.amountProperty ?? 'nicht hinterlegt'} (${m.revenue.amountUnit})`,
        `Währung: ${m.revenue.currencyProperty ?? `Annahme ${m.revenue.fallbackCurrency}`}`,
        `Als Umsatz anerkannt ab: ${labelList(m.revenue.recognizedStageIds)}`,
      ];
    case 'lost_rules':
      return [
        `Verloren-Stages: ${labelList(m.lostRules.lostStageIds)}`,
        `Verlustgrund: ${m.lostRules.lostReasonProperty ?? 'nicht hinterlegt'}`,
        `No-Show: ${m.lostRules.noShowProperty ?? labelList(m.lostRules.noShowStageIds)}`,
      ];
    case 'vq':
      return [
        `Status-Eigenschaft: ${m.vq.statusProperty ?? 'nicht hinterlegt'}`,
        `Wertzuordnung: ${labelList(Object.keys(m.vq.statusValueMap))}`,
        `Score: ${m.vq.scoreProperty ?? 'nicht hinterlegt'} (${m.vq.scoreMin}–${m.vq.scoreMax})`,
      ];
    case 'acquisition_fields':
      return [
        `Kontaktfelder: ${labelList(Object.keys(m.acquisition.contactProperties))}`,
        `Dealfelder: ${labelList(Object.keys(m.acquisition.dealProperties))}`,
        `Einmalig schreiben: ${m.acquisition.writeOnce ? 'ja' : 'nein'}`,
      ];
    case 'form_fields':
      return m.formFieldMappings.length === 0
        ? ['Keine Formularfeldzuordnung hinterlegt.']
        : m.formFieldMappings.map((f) => `${f.fieldKey} → ${f.property} (${f.transform})`);
    case 'test_lead':
      return [
        `E-Mail-Domain: ${m.testLead.emailDomain ?? 'nicht hinterlegt'}`,
        `Kennzeichnung: ${m.testLead.markerProperty ?? 'nicht hinterlegt'} = ${m.testLead.markerValue}`,
        `Bereinigung: ${m.testLead.cleanup}`,
      ];
    case 'webhooks':
      return [
        `Objekttypen: ${labelList(m.webhook.subscribedObjectTypes)}`,
        `Eigenschaften: ${labelList(m.webhook.subscribedProperties)}`,
        `Toleranz: ${m.webhook.toleranceSeconds} s`,
      ];
    default:
      return [];
  }
}

function toHubspotSteps(m: HubspotMappingDocument): HubspotStepView[] {
  const validation = validateMapping(m);
  return MAPPING_WIZARD_STEPS.map((step) => {
    const issues = validation.issues.filter((i) => i.step === step.key);
    return {
      key: step.key,
      order: step.order,
      labelDe: step.labelDe,
      descriptionDe: step.descriptionDe,
      requiredForLaunch: step.requiredForLaunch,
      issues,
      complete: !issues.some((i) => i.severity === 'ERROR'),
      summaryDe: stepSummary(step.key, m),
    };
  });
}

function versionSummaries(): MappingVersionSummary[] {
  const sourceLabel: Record<HubspotMappingDocument['source'], string> = {
    FIXTURE: 'Fixture-Mapping',
    WIZARD: 'Assistent',
    IMPORTED: 'Importiert',
  };
  const published: MappingVersionSummary[] = state.mappingVersions.map((v) => ({
    id: v.id,
    version: v.version,
    status: v.status,
    publishedAt: v.publishedAt,
    sourceDe: sourceLabel[v.source],
    notesDe: v.notesDe,
  }));
  return [
    ...published,
    {
      id: state.mappingDraft.id,
      version: state.mappingDraft.version,
      status: 'DRAFT',
      publishedAt: null,
      sourceDe: sourceLabel[state.mappingDraft.source],
      notesDe: state.mappingDraft.notesDe,
    },
  ];
}

async function buildHubspotMapping(flags: FeatureFlags): Promise<HubspotMappingSnapshot> {
  const draft = state.mappingDraft;
  const validation = validateMapping(draft);
  const complete = requiredMappingsComplete(draft);
  const testLeadPassed = state.testLead?.gatePassed === true;

  const missingForLaunchDe = [
    ...missingRequiredMappings(draft).map((i) => i.messageDe),
    ...(testLeadPassed
      ? []
      : [
          'Es liegt noch kein erfolgreicher Test-Lead vor. Der Live-Launch bleibt gesperrt, bis Kontakt, Deal und Verknüpfung in HubSpot nachgewiesen wurden.',
        ]),
  ];

  return {
    generatedAt: iso(0),
    connection: await hubspotHealth(flags),
    draft,
    versions: versionSummaries(),
    steps: toHubspotSteps(draft),
    validation,
    canPublish: canPublishMapping(draft),
    launchReady: complete && testLeadPassed,
    missingForLaunchDe,
    testLead: state.testLead,
    webhookTest: state.webhookTest,
    reconciliationTest: state.reconciliationTest,
    flags,
  };
}

/* -------------------------------------------------------------------------- */
/* Integrations overview                                                       */
/* -------------------------------------------------------------------------- */

function outboxCounts() {
  return {
    pending: state.outbox.filter((e) => e.status === 'PENDING' || e.status === 'PROCESSING').length,
    retrying: state.outbox.filter((e) => e.status === 'FAILED_RETRYING').length,
    dead: state.outbox.filter((e) => e.status === 'DEAD_LETTER').length,
  };
}

function connectionFor(
  provider: Provider,
  health: ProviderHealth,
  accountLabel: string | null,
): ProviderCardData['connection'] {
  return {
    id: `connection-${provider.toLowerCase()}`,
    provider,
    state: health.state,
    accountLabel,
    externalAccountId: null,
    grantedScopes: [],
    connectedAt: health.state === 'CONNECTED' ? iso(-4320) : null,
    expiresAt: null,
    lastCheckedAt: health.checkedAt,
  };
}

async function buildIntegrations(flags: FeatureFlags): Promise<IntegrationsSnapshot> {
  const [meta, hubspot] = await Promise.all([metaHealth(flags), hubspotHealth(flags)]);
  const openai = openAiHealth();
  const supabase = supabaseHealth();

  const modeDe = (health: ProviderHealth, live: string): string =>
    health.state === 'FIXTURE'
      ? 'Fixture-Modus: keine Verbindung zum Anbieter, alle Daten stammen aus dem Testdatensatz.'
      : health.state === 'NOT_CONFIGURED'
        ? 'Nicht konfiguriert: es sind keine Zugangsdaten hinterlegt.'
        : live;

  return {
    generatedAt: iso(0),
    flags,
    providers: [
      {
        provider: 'META',
        connection: connectionFor('META', meta, null),
        health: meta,
        lastSyncAt: iso(-55),
        errorCount: state.outbox.filter(
          (e) => e.destination !== 'HUBSPOT' && e.status === 'FAILED_RETRYING',
        ).length,
        deadLetterCount: state.outbox.filter(
          (e) => e.destination !== 'HUBSPOT' && e.status === 'DEAD_LETTER',
        ).length,
        modeDe: modeDe(meta, 'Live-Verbindung zur Meta Marketing API.'),
        setupHref: '/integrationen/meta',
        setupLabelDe: 'Meta-Assistent öffnen',
      },
      {
        provider: 'HUBSPOT',
        connection: connectionFor('HUBSPOT', hubspot, state.mappingDraft.portalId),
        health: hubspot,
        lastSyncAt: state.testLead?.status === 'PASS' ? state.testLead.finishedAt : null,
        errorCount: state.outbox.filter(
          (e) => e.destination === 'HUBSPOT' && e.status === 'FAILED_RETRYING',
        ).length,
        deadLetterCount: state.outbox.filter(
          (e) => e.destination === 'HUBSPOT' && e.status === 'DEAD_LETTER',
        ).length,
        modeDe: modeDe(hubspot, 'Live-Verbindung zum HubSpot-Portal.'),
        setupHref: '/integrationen/hubspot',
        setupLabelDe: 'Mapping-Assistent öffnen',
      },
      {
        provider: 'OPENAI',
        connection: connectionFor('OPENAI', openai, null),
        health: openai,
        lastSyncAt: null,
        errorCount: 0,
        deadLetterCount: 0,
        modeDe: modeDe(openai, 'Live-Verbindung zur OpenAI Responses API.'),
        setupHref: null,
        setupLabelDe: null,
      },
      {
        provider: 'SUPABASE',
        connection: connectionFor('SUPABASE', supabase, null),
        health: supabase,
        lastSyncAt: null,
        errorCount: 0,
        deadLetterCount: 0,
        modeDe: modeDe(supabase, 'Live-Verbindung zum Supabase-Projekt.'),
        setupHref: null,
        setupLabelDe: null,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Outbox                                                                      */
/* -------------------------------------------------------------------------- */

const DESTINATION_LABELS_DE: Readonly<Record<OutboxEvent['destination'], string>> = {
  META_CAPI: 'Meta Conversions API',
  META_MARKETING_API: 'Meta Marketing API',
  HUBSPOT: 'HubSpot',
};

function buildOutbox(): OutboxSnapshot {
  const counts = outboxCounts();
  const rows: OutboxRow[] = state.outbox.map((event) => ({
    event,
    destinationLabelDe: DESTINATION_LABELS_DE[event.destination],
    retryable: event.status === 'FAILED_RETRYING' || event.status === 'DEAD_LETTER',
    href: event.campaign_id ? `/kampagnen/${event.campaign_id}` : null,
  }));
  return {
    generatedAt: iso(0),
    rows,
    pendingCount: counts.pending,
    retryingCount: counts.retrying,
    deadLetterCount: counts.dead,
  };
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

const FLAG_LABELS_DE: Readonly<Record<keyof FeatureFlags, { labelDe: string; envVar: string; explanationDe: string }>> = {
  demoMode: {
    labelDe: 'Demo-Modus',
    envVar: 'DEMO_MODE',
    explanationDe:
      'Alle Anbieter laufen gegen deterministische Fixtures. Es wird nie behauptet, ein echter Anbieter sei verbunden.',
  },
  externalWritesEnabled: {
    labelDe: 'Externe Schreibzugriffe',
    envVar: 'EXTERNAL_WRITES_ENABLED',
    explanationDe:
      'Hauptschalter. Solange er aus ist, liefert jeder Adapter einen Dry-Run statt eines Schreibvorgangs — unabhängig von den spezifischeren Schaltern.',
  },
  metaMutationsEnabled: {
    labelDe: 'Meta-Schreibzugriffe',
    envVar: 'META_MUTATIONS_ENABLED',
    explanationDe:
      'Erlaubt das Anlegen pausierter Entwürfe und Budget-/Statusänderungen — nur zusammen mit dem Hauptschalter.',
  },
  metaCapiEnabled: {
    labelDe: 'Conversions API',
    envVar: 'META_CAPI_ENABLED',
    explanationDe:
      'Erlaubt den serverseitigen Ereignisversand an Meta — nur zusammen mit dem Hauptschalter.',
  },
  hubspotWritesEnabled: {
    labelDe: 'HubSpot-Schreibzugriffe',
    envVar: 'HUBSPOT_WRITES_ENABLED',
    explanationDe:
      'Erlaubt das Anlegen und Aktualisieren von Kontakten und Deals — nur zusammen mit dem Hauptschalter.',
  },
};

function flagViews(flags: FeatureFlags): FeatureFlagView[] {
  return (Object.keys(FLAG_LABELS_DE) as Array<keyof FeatureFlags>).map((key) => ({
    key,
    value: flags[key],
    labelDe: FLAG_LABELS_DE[key].labelDe,
    envVar: FLAG_LABELS_DE[key].envVar,
    explanationDe: FLAG_LABELS_DE[key].explanationDe,
  }));
}

function buildSettings(flags: FeatureFlags): SettingsSnapshot {
  return {
    generatedAt: iso(0),
    members: state.members,
    roleBudgetLimits: state.roleBudgetLimits,
    approvalThresholds: state.approvalThresholds,
    experimentThresholds: state.experimentThresholds,
    recommendationConfig: state.recommendationConfig,
    attributionWindowDays: state.attributionWindowDays,
    consentVersions: state.consentVersions,
    retention: state.retention,
    brand: state.brand,
    featureFlags: flagViews(flags),
  };
}

/* -------------------------------------------------------------------------- */
/* Port                                                                        */
/* -------------------------------------------------------------------------- */

export function createFixtureOpsPort(): OpsPort {
  const flags = (): FeatureFlags => getFeatureFlags();

  return {
    async loadToday() {
      return buildToday(flags());
    },

    async loadLibrary() {
      return buildLibrary();
    },

    async loadIntegrations() {
      return buildIntegrations(flags());
    },

    async loadMetaSetup() {
      return buildMetaSetup(flags());
    },

    async loadHubspotMapping() {
      return buildHubspotMapping(flags());
    },

    async loadOutbox() {
      return buildOutbox();
    },

    async loadSettings() {
      return buildSettings(flags());
    },

    async recheckProvider({ provider }) {
      const current = flags();
      switch (provider) {
        case 'META':
          return metaHealth(current);
        case 'HUBSPOT':
          return hubspotHealth(current);
        case 'OPENAI':
          return openAiHealth();
        case 'SUPABASE':
          return supabaseHealth();
      }
    },

    async retryOutboxEvent({ eventId }) {
      const event = state.outbox.find((e) => e.event_id === eventId);
      if (!event) {
        return {
          eventId,
          state: 'DEAD_LETTER',
          messageDe: 'Dieses Ereignis existiert nicht mehr.',
          providerConfirmed: false,
          dryRun: null,
        };
      }

      const current = flags();
      const provider = event.destination === 'HUBSPOT' ? 'HUBSPOT' : 'META';
      const writesEnabled =
        current.externalWritesEnabled &&
        (provider === 'HUBSPOT' ? current.hubspotWritesEnabled : current.metaCapiEnabled);

      if (!writesEnabled) {
        return {
          eventId,
          state: event.status,
          messageDe:
            'Dry-Run – nicht ausgeführt. Der Wiederholungsversuch wurde vorbereitet, aber nichts gesendet.',
          providerConfirmed: false,
          dryRun: dryRun(
            provider,
            `outbox.retry:${event.event_name}`,
            {
              event_id: event.event_id,
              event_name: event.event_name,
              event_time: event.event_time,
              destination: event.destination,
              attempt: event.attempt_count + 1,
            },
            provider === 'HUBSPOT'
              ? 'HubSpot-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / HUBSPOT_WRITES_ENABLED).'
              : 'Der Conversions-API-Versand ist deaktiviert (EXTERNAL_WRITES_ENABLED / META_CAPI_ENABLED).',
          ),
        };
      }

      // Writes are on, but this port talks to a fixture provider. A fixture
      // acknowledgement is never reported as a provider confirmation.
      event.status = 'SENT';
      event.attempt_count += 1;
      event.next_attempt_at = null;
      event.last_error = null;
      return {
        eventId,
        state: event.status,
        messageDe:
          'Der Versand wurde ausgelöst. Bestätigt gilt das Ereignis erst, wenn der Anbieter es quittiert hat — im Fixture-Modus geschieht das nicht.',
        providerConfirmed: false,
        dryRun: null,
      };
    },

    async saveMappingStep({ patch }) {
      const merged = mappingDocumentSchema.parse({ ...state.mappingDraft, ...patch, status: 'DRAFT' });
      state.mappingDraft = merged;
      // Any mapping change invalidates the previous end-to-end evidence.
      state.testLead = null;
      return buildHubspotMapping(flags());
    },

    async applyFixtureMapping() {
      // The complete fixture document, kept `source: 'FIXTURE'` so nothing in
      // the UI can mistake it for the customer's real portal description.
      state.mappingDraft = mappingDocumentSchema.parse({
        ...FIXTURE_MAPPING,
        id: state.mappingDraft.id,
        version: state.mappingDraft.version,
        status: 'DRAFT',
        publishedAt: null,
        publishedBy: null,
      });
      state.testLead = null;
      return buildHubspotMapping(flags());
    },

    async publishMapping({ publishedBy, now }) {
      const previousVersion = state.mappingVersions.at(-1)?.version ?? 0;
      const result = publishMappingDocument(state.mappingDraft, {
        publishedBy,
        now,
        previousVersion,
      });
      if (!result.published) {
        return {
          published: false,
          version: null,
          issues: result.issues,
          messageDe: `Die Version wurde nicht veröffentlicht: ${result.issues.length} blockierende Angabe(n) fehlen.`,
        };
      }
      // A published version is immutable: it is appended, and the draft becomes
      // a new, separate document for the next round of changes.
      state.mappingVersions = [...state.mappingVersions, result.document];
      state.mappingDraft = mappingDocumentSchema.parse({
        ...result.document,
        status: 'DRAFT',
        publishedAt: null,
        publishedBy: null,
        version: result.document.version,
      });
      return {
        published: true,
        version: result.document.version,
        issues: result.issues,
        messageDe: `Mapping-Version ${result.document.version} wurde veröffentlicht und ist unveränderlich. Änderungen erzeugen eine neue Version.`,
      };
    },

    async runMappingTestLead({ initiatedBy }) {
      const current = flags();
      const result = await runTestLead(
        { mapping: state.mappingDraft, initiatedBy },
        {
          provider: hubspotProviderInstance(current),
          store: createInMemorySyncStore(),
          flags: current,
        },
      );
      state.testLead = result;
      return result;
    },

    async runWebhookTest() {
      const mapping = state.mappingDraft;
      const configured = mapping.webhook.subscribedObjectTypes.length > 0;
      const result: ProbeResultView = {
        key: 'webhook_test',
        labelDe: 'Webhook-Test',
        status: configured ? 'AWAITING_EXTERNAL_INPUT' : 'FAIL',
        detailDe: configured
          ? `Abonnements für ${labelList(mapping.webhook.subscribedObjectTypes)} sind hinterlegt. Signaturen können erst geprüft werden, wenn HUBSPOT_WEBHOOK_SECRET gesetzt ist — bis dahin werden eingehende Webhooks abgelehnt.`
          : 'Es sind keine Webhook-Abonnements hinterlegt. Änderungen in HubSpot würden nur über den stündlichen Abgleich erkannt.',
        checkedAt: iso(0),
        dryRun: null,
      };
      state.webhookTest = result;
      return result;
    },

    async runReconciliationTest() {
      const current = flags();
      const report = await reconcile(
        { scope: 'HOURLY', mapping: state.mappingDraft },
        {
          provider: hubspotProviderInstance(current),
          store: createInMemorySyncStore(),
          now: () => iso(0),
        },
      );
      const result: ProbeResultView = {
        key: 'reconciliation_test',
        labelDe: 'Abgleich-Test',
        status: report.discrepancies.length > 0 ? 'WARN' : 'PASS',
        detailDe: [
          `${report.objectsRead} Objekt(e) gelesen, ${report.eventsEmitted.length} Ereignis(se) erzeugt, ${report.discrepancies.length} Abweichung(en).`,
          ...report.correctionsDe,
          ...report.messagesDe,
        ].join(' '),
        checkedAt: iso(0),
        dryRun: null,
      };
      state.reconciliationTest = result;
      return result;
    },

    async saveMemberRoles({ memberId, roles }) {
      state.members = state.members.map((m) => (m.id === memberId ? { ...m, roles } : m));
      return buildSettings(flags());
    },

    async saveRoleBudgetLimit({ limit }) {
      state.roleBudgetLimits = { ...state.roleBudgetLimits, [limit.role]: limit };
      return buildSettings(flags());
    },

    async saveApprovalThresholds({ thresholds }) {
      state.approvalThresholds = thresholds;
      return buildSettings(flags());
    },

    async saveExperimentThresholds({ thresholds }) {
      state.experimentThresholds = thresholds;
      return buildSettings(flags());
    },

    async saveRecommendationConfig({ config }) {
      state.recommendationConfig = config;
      return buildSettings(flags());
    },

    async saveAttributionWindow({ windowDays }) {
      state.attributionWindowDays = windowDays;
      return buildSettings(flags());
    },

    async addConsentVersion({ textDe, purposes, privacyPolicyUrl, now }) {
      const previous = state.consentVersions.at(-1) ?? null;
      const nextVersion = (previous?.version ?? 0) + 1;
      // A consent text is never edited in place: the old version keeps its
      // wording and gets an end date, the new text becomes a new version.
      state.consentVersions = [
        ...state.consentVersions.map((v) =>
          v.effectiveUntil === null ? { ...v, effectiveUntil: now } : v,
        ),
        {
          id: `aaaaaaa1-0000-4000-8000-${String(nextVersion).padStart(12, '0')}`,
          version: nextVersion,
          textDe,
          purposes,
          privacyPolicyUrl,
          effectiveFrom: now,
          effectiveUntil: null,
        },
      ];
      return buildSettings(flags());
    },

    async saveRetentionPolicy({ policy, configuredBy, now }) {
      state.retention = { ...policy, configuredBy, configuredAt: now };
      return buildSettings(flags());
    },

    async saveBrandTokens({ brand }) {
      state.brand = brand;
      return buildSettings(flags());
    },
  };
}

let port: OpsPort | null = null;

/**
 * The port the routes use. A single instance so fixture mutations survive
 * between requests within one server process.
 */
export function getOpsPort(): OpsPort {
  port ??= createFixtureOpsPort();
  return port;
}
