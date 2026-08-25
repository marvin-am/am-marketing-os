import {
  canTransition,
  canWriteMeta,
  CREATIVE_PRINCIPLES,
  DEFAULT_ROLE_BUDGET_LIMITS,
  dryRun,
  fnv1a32,
  GENERATION_DEFAULTS,
  isApprovalValid,
  LAUNCH_CHECK_KEYS,
  LAUNCH_CHECK_LABELS_DE,
  LIVE_ONLY_CHECKS,
  METRIC_CATALOG,
  rate,
  REQUIRED_APPROVALS_FOR_STATE,
  summarizeLaunchQa,
  validateFunnelMix,
  type Approval,
  type ApprovalKind,
  type AspectRatio,
  type AssetReviewState,
  type AuditAction,
  type AuditLog,
  type CampaignState,
  type ClaimSpec,
  type CreativeConcept,
  type CreativePrinciple,
  type DataMaturity,
  type ExternalCommand,
  type FunnelProposal,
  type HealthStatus,
  type LaunchCheckResult,
  type LearningCard,
  type MetricKey,
  type MetricValue,
  type RecommendationState,
  type Role,
} from '@am/domain';
import { getFeatureFlags } from '@am/config';
import { resolveDatabase, type AmDatabase } from '@am/db';
import { draftNameWithMarker } from '@am/meta';
import { FIXTURE_IDS } from '@am/funnel-schema';
import { logger } from '@am/observability';
import { actionDryRun, actionError, actionOk, type ActionResult } from '@/lib/action-result';
import { rolesWithPermission, ROLE_LABELS_DE } from '@/lib/permissions';
import { readCampaignAuditLog } from './audit-sink';
import { createDatabaseCampaignPort } from './campaign-db-port';
import {
  assetsContentHash,
  campaignContentHash,
  publishContentHash,
  strategyContentHash,
  testPlanContentHash,
  type AssetsContent,
  type StrategyContent,
  type TestPlanContent,
} from './campaign-content-hash';
import { createPgTransactionRunner } from './campaign-transaction';
import type {
  ApprovalDecisionInput,
  ApprovalStatus,
  BudgetChangeInput,
  CampaignHeaderView,
  CampaignListPage,
  CampaignListQuery,
  CampaignListRow,
  CampaignPort,
  CampaignReality,
  CampaignVersionEntry,
  CommandOutcome,
  CreativeBoardView,
  CreativeCard,
  CreativeReviewInput,
  CrmFunnelStage,
  DiversityCheckView,
  FunnelOverviewView,
  FunnelVariantView,
  HistoryView,
  LaunchQaView,
  LeadRow,
  LeadSyncRetryInput,
  LeadsSalesView,
  LivePerformanceView,
  MetaWritePreview,
  MoneyAmount,
  NextRequiredAction,
  PerformanceBreakdownRow,
  PerformancePoint,
  ProviderSyncStatus,
  RecommendationDecisionInput,
  RecommendationExecutionInput,
  RecommendationView,
  StrategyView,
  TestPlanView,
  TransitionInput,
} from './campaign-port';
import { campaignTabHref } from './campaign-port';

/**
 * The demo-mode `CampaignPort`, backed by the fixture data the packages ship.
 *
 * This is what makes the campaign list and the whole Campaign Room walkable with
 * no database at all — `DEMO_MODE=true`, no credentials, the E2E suite. It is a
 * fixture and it behaves like one: state lives in module scope and is lost when
 * the server process restarts. It is not a cache and not a stand-in for a
 * database; once a Supabase project is configured and demo mode is off,
 * `getCampaignPort()` returns the repository-backed port instead.
 *
 * What it does model faithfully, because the UI states these as facts:
 *
 * - an approval covers a **content hash**; changing the content invalidates it
 *   along `INVALIDATION_MAP` and the approval must be granted again,
 * - launch is blocked below `GENERATION_DEFAULTS.minApprovedCreatives`
 *   conceptually distinct creatives, and the colliding pairs are named,
 * - a budget change beyond a role's authority is **refused** with the approving
 *   role named — never clamped,
 * - a Meta write with `EXTERNAL_WRITES_ENABLED=false` returns a `DryRunResult`,
 *   never a success — including the step into a state whose very name claims a
 *   Meta object exists, which is therefore not recorded either.
 */

/* -------------------------------------------------------------------------- */
/* Deterministic helpers                                                       */
/* -------------------------------------------------------------------------- */

const ANCHOR = Date.parse('2026-08-25T09:00:00.000Z');

function iso(offsetDays: number, offsetHours = 0): string {
  return new Date(ANCHOR + offsetDays * 86_400_000 + offsetHours * 3_600_000).toISOString();
}

function isoDate(offsetDays: number): string {
  return iso(offsetDays).slice(0, 10);
}

/** Stable pseudo-uuid so every fixture id survives a restart unchanged. */
function fixtureUuid(seed: string): string {
  const a = fnv1a32(`a:${seed}`) >>> 0;
  const b = fnv1a32(`b:${seed}`) >>> 0;
  const c = fnv1a32(`c:${seed}`) >>> 0;
  const d = fnv1a32(`d:${seed}`) >>> 0;
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return [
    hex(a),
    hex(b).slice(0, 4),
    `4${hex(b).slice(5, 8)}`,
    `8${hex(c).slice(1, 4)}`,
    `${hex(c).slice(4, 8)}${hex(d)}`,
  ].join('-');
}

/**
 * 64-hex content hash, shared with the repository-backed port so an approval
 * granted against one store means the same thing in the other.
 */
export const fixtureContentHash = campaignContentHash;

function seededInt(seed: string, min: number, max: number): number {
  const span = max - min + 1;
  return min + ((fnv1a32(seed) >>> 0) % span);
}

/* -------------------------------------------------------------------------- */
/* Shared content                                                              */
/* -------------------------------------------------------------------------- */


const CONCEPT_SEEDS: ReadonlyArray<{
  name: string;
  principle: CreativePrinciple;
  visualIdea: string;
  headline: string;
  primaryText: string;
  description: string;
  hypothesis: string;
  rationale: string;
  proofUsed: string | null;
  funnelPromise: string;
}> = [
  {
    name: 'Der Monat ohne Anfragen',
    principle: 'PROBLEM_PAIN',
    visualIdea:
      'Leerer Werkstattkalender an der Wand, drei Wochen ohne Eintrag, warmes Morgenlicht, keine Typografie im Bild.',
    headline: 'Drei Wochen ohne neue Anfrage',
    primaryText:
      'Der Kalender war im März zu zwei Dritteln leer — nicht weil die Arbeit schlecht war, sondern weil niemand wusste, wann die nächste Anfrage kommt. Genau das lässt sich planbar machen.',
    description: 'Potenzialanalyse in zwei Minuten',
    hypothesis:
      'Die Zielgruppe reagiert stärker auf das konkret erlebte Auslastungsloch als auf abstrakte Wachstumsversprechen.',
    rationale:
      'Der Schmerz ist saisonal erlebt und damit unmittelbar wiedererkennbar, ohne eine Zahl zu behaupten.',
    proofUsed: null,
    funnelPromise: 'Zeigt in zwei Minuten, wie viele Anfragen realistisch planbar wären.',
  },
  {
    name: 'Vierzehn Anfragen im Quartal',
    principle: 'CONCRETE_RESULT',
    visualIdea:
      'Aufgeräumter Schreibtisch mit einem gefüllten Wochenplan, ruhige Farbflächen, kein Text im Motiv.',
    headline: 'Von 3 auf 14 Anfragen im Quartal',
    primaryText:
      'Ein Betrieb mit 22 Mitarbeitenden hat im letzten Quartal 14 qualifizierte Anfragen erhalten statt der üblichen drei. Der Unterschied lag nicht am Budget, sondern an der Reihenfolge der Fragen im Erstkontakt.',
    description: 'Kostenlose Potenzialanalyse',
    hypothesis:
      'Eine konkrete, belegte Ergebniszahl schlägt eine allgemeine Nutzenaussage bei kaufbereiten Geschäftsführungen.',
    rationale: 'Das Ergebnis ist durch einen freigegebenen Case belegt und damit zitierfähig.',
    proofUsed: 'Case Study Elektro Krämer, freigegeben am 12.06.2026',
    funnelPromise: 'Rechnet das eigene Anfragepotenzial anhand von sechs Angaben aus.',
  },
  {
    name: 'Agentur oder eigener Kanal',
    principle: 'COMPARISON_ALTERNATIVE',
    visualIdea:
      'Zwei nebeneinanderliegende Werkbänke, eine geliehen, eine eigene, gleiche Beleuchtung, kein Text.',
    headline: 'Geliehene Reichweite oder eigener Kanal',
    primaryText:
      'Eine Agentur bringt Reichweite, solange sie bezahlt wird. Ein eigener, dokumentierter Anfragekanal bleibt, wenn das Budget einmal pausiert. Der Unterschied zeigt sich erst im vierten Monat.',
    description: 'Vergleich in zwei Minuten',
    hypothesis:
      'Der Vergleich zur bereits bekannten Alternative senkt die wahrgenommene Wechselhürde stärker als ein reines Nutzenversprechen.',
    proofUsed: null,
    rationale: 'Die Alternative ist der Zielgruppe vertraut, das macht den Kontrast greifbar.',
    funnelPromise: 'Stellt den eigenen Kanal der Agenturlösung mit den eigenen Zahlen gegenüber.',
  },
  {
    name: 'Was 42 Betriebe gezeigt haben',
    principle: 'PROOF_CASE_DATAPOINT',
    visualIdea:
      'Nahaufnahme einer handschriftlichen Auswertung auf Millimeterpapier, sachlich, ohne Typografie im Bild.',
    headline: '42 Betriebe, ein wiederkehrendes Muster',
    primaryText:
      'In 42 ausgewerteten Erstgesprächen stand fast immer dieselbe Ursache am Anfang: Die Qualifizierung passierte zu spät. Wer sie vorzieht, verliert weniger Termine an No-Shows.',
    description: 'Auswertung ansehen',
    hypothesis:
      'Ein aggregierter, belegter Datenpunkt erzeugt mehr Vertrauen als eine einzelne Erfolgsgeschichte.',
    rationale: 'Der Datenpunkt stammt aus einer freigegebenen internen Auswertung.',
    proofUsed: 'Interne Auswertung 42 Erstgespräche, freigegeben am 04.05.2026',
    funnelPromise: 'Ordnet den eigenen Betrieb in das Muster der 42 Auswertungen ein.',
  },
  {
    name: 'Kein Budget für Experimente',
    principle: 'OBJECTION_HANDLING',
    visualIdea:
      'Zwei Hände, die eine Kostenaufstellung durchgehen, ruhige Bildsprache, kein Text im Motiv.',
    headline: 'Ohne Budget für Experimente',
    primaryText:
      'Der häufigste Einwand ist nicht Zweifel, sondern Kassenlage: Für ein Experiment ohne absehbares Ergebnis ist kein Geld da. Deshalb steht am Anfang eine Analyse, die nichts kostet und trotzdem eine Zahl liefert.',
    description: 'Analyse ohne Kosten',
    hypothesis:
      'Das explizite Aussprechen des Budgeteinwands senkt die Einstiegshürde stärker als ein zusätzlicher Nutzen.',
    rationale: 'Der Einwand ist in Erstgesprächen dokumentiert und wird direkt adressiert.',
    proofUsed: null,
    funnelPromise: 'Liefert eine belastbare Einschätzung, bevor irgendein Budget fließt.',
  },
  {
    name: 'Mehr Reichweite ist das falsche Ziel',
    principle: 'CONTRARIAN_INSIGHT',
    visualIdea:
      'Ein voller Wartebereich, in dem nur zwei Personen wirklich passen — Bildidee ohne Typografie.',
    headline: 'Mehr Anfragen sind das falsche Ziel',
    primaryText:
      'Wer die Anfragen verdoppelt, verdoppelt meistens auch die Absagen. Der Hebel liegt in der Qualifizierung vor dem Termin, nicht in zusätzlicher Reichweite.',
    description: 'Qualifizierung zuerst',
    hypothesis:
      'Eine der Erwartung widersprechende These erzeugt bei erfahrenen Geschäftsführungen mehr Aufmerksamkeit als eine Bestätigung.',
    rationale: 'Die These widerspricht der üblichen Kanalerzählung und ist damit merkfähig.',
    proofUsed: null,
    funnelPromise: 'Trennt vorab, für wen sich ein Gespräch überhaupt lohnt.',
  },
];

function buildConcept(index: number): CreativeConcept {
  const seed = CONCEPT_SEEDS[index];
  return {
    key: `concept_${index + 1}`,
    name: seed.name,
    principle: seed.principle,
    visualIdea: seed.visualIdea,
    imagePrompt: `${seed.visualIdea} Dokumentarische Fotografie, natürliches Licht, keine Schrift, kein Logo, kein UI.`,
    copy: {
      primaryText: seed.primaryText,
      headline: seed.headline,
      description: seed.description,
      callToAction: 'Jetzt Potenzial prüfen',
    },
    hypothesis: seed.hypothesis,
    rationale: seed.rationale,
    proofUsed: seed.proofUsed,
    funnelPromise: seed.funnelPromise,
    altText: `${seed.visualIdea.split(',')[0]} — Motiv der Anzeige „${seed.headline}".`,
    aspectRatios: ['1:1', '4:5'],
    claims:
      seed.proofUsed === null
        ? [
            {
              text: seed.headline,
              evidence: null,
              confidence: 'HYPOTHESIS',
              requiresHypothesisLabel: true,
            },
          ]
        : [
            {
              text: seed.headline,
              evidence: {
                evidenceItemId: FIXTURE_IDS.evidenceItemId,
                kind: 'CASE_STUDY',
                summary: seed.proofUsed,
                sourceRef: 'evidence/case-study-kraemer',
              },
              confidence: 'FACT',
              requiresHypothesisLabel: false,
            },
          ],
  };
}

const CONCEPTS: CreativeConcept[] = CONCEPT_SEEDS.map((_, index) => buildConcept(index));

const CLAIMS: ClaimSpec[] = [
  {
    text: 'Ein dokumentierter Anfragekanal macht die Auslastung planbar.',
    evidence: {
      evidenceItemId: FIXTURE_IDS.evidenceItemId,
      kind: 'HISTORICAL_PERFORMANCE',
      summary: 'Auswertung von 42 Erstgesprächen aus dem Zeitraum 01/2026 bis 05/2026.',
      sourceRef: 'evidence/auswertung-42-erstgespraeche',
    },
    confidence: 'FACT',
    requiresHypothesisLabel: false,
  },
  {
    text: 'Ein Betrieb mit 22 Mitarbeitenden kam von 3 auf 14 qualifizierte Anfragen je Quartal.',
    evidence: {
      evidenceItemId: FIXTURE_IDS.caseStudyId,
      kind: 'CASE_STUDY',
      summary: 'Case Study Elektro Krämer, vom Kunden am 12.06.2026 freigegeben.',
      sourceRef: 'evidence/case-study-kraemer',
    },
    confidence: 'FACT',
    requiresHypothesisLabel: false,
  },
  {
    text: 'Eine vorgezogene Qualifizierung senkt die No-Show-Quote spürbar.',
    evidence: null,
    confidence: 'HYPOTHESIS',
    requiresHypothesisLabel: true,
  },
  {
    text: 'Geschäftsführungen entscheiden eher nach Planbarkeit als nach Preis.',
    evidence: null,
    confidence: 'HYPOTHESIS',
    requiresHypothesisLabel: true,
  },
];

const FUNNEL_PROPOSALS: FunnelProposal[] = [
  {
    key: 'funnel_1',
    kind: 'MULTI_STEP_FORM',
    name: 'Potenzialanalyse — sechs Fragen',
    rationale:
      'Die Qualifizierung wird vor den Termin gezogen, damit Absagen vor statt nach dem Gespräch passieren.',
    hypothesis:
      'Sechs Fragen vor der Kontaktabfrage erhöhen die Terminqualität, ohne die Abschlussrate des Formulars zu halbieren.',
    promise: 'In zwei Minuten sehen, wie viele Anfragen realistisch planbar sind.',
    qualificationQuestionCount: 6,
    questionOutline: [
      'Wie viele Mitarbeitende hat der Betrieb?',
      'Wie kommen heute die meisten Anfragen zustande?',
      'Wie viele Anfragen kommen pro Monat?',
      'Wie hoch ist der durchschnittliche Auftragswert?',
      'Wer entscheidet über Marketingbudgets?',
      'Ab wann soll es losgehen?',
    ],
    resultConcept:
      'Eine Einordnung des eigenen Betriebs mit Spannbreite statt Punktwert und ein konkreter nächster Schritt.',
  },
  {
    key: 'funnel_2',
    kind: 'MULTI_STEP_FORM',
    name: 'Potenzialanalyse — vier Fragen',
    rationale:
      'Kurzvariante als Kontrolle: prüft, ob die zusätzlichen zwei Fragen die Abschlussrate kosten.',
    hypothesis:
      'Vier Fragen erhöhen die Submission-Rate, senken aber den Anteil qualifizierter VQs.',
    promise: 'In unter einer Minute eine erste Einschätzung erhalten.',
    qualificationQuestionCount: 4,
    questionOutline: [
      'Wie viele Mitarbeitende hat der Betrieb?',
      'Wie viele Anfragen kommen pro Monat?',
      'Wie hoch ist der durchschnittliche Auftragswert?',
      'Ab wann soll es losgehen?',
    ],
    resultConcept: 'Kurzeinordnung mit Hinweis auf die ausführliche Analyse im Gespräch.',
  },
  {
    key: 'funnel_3',
    kind: 'LANDING_PAGE',
    name: 'Landingpage mit Direktkontakt',
    rationale:
      'Referenzarm ohne Qualifizierungsstrecke, um den Effekt der Strecke überhaupt messen zu können.',
    hypothesis:
      'Die Landingpage liefert mehr Leads bei deutlich schlechterer Terminqualität.',
    promise: 'Direkt ein Erstgespräch vereinbaren.',
    qualificationQuestionCount: 4,
    questionOutline: [],
    resultConcept: 'Direkte Terminbuchung ohne vorgelagerte Qualifizierung.',
  },
];

/* -------------------------------------------------------------------------- */
/* Campaign records                                                            */
/* -------------------------------------------------------------------------- */

interface CampaignSpec {
  slug: string;
  name: string;
  state: CampaignState;
  angleName: string;
  offerName: string;
  /** Approvals already granted, in order. */
  granted: ApprovalKind[];
  /** Approval kinds granted but invalidated by a later content change. */
  invalidated: ApprovalKind[];
  /** Concept keys already approved. */
  approvedConcepts: string[];
  /** Two concept keys that are conceptually the same idea, if any. */
  collision: [string, string] | null;
  hasPerformance: boolean;
  dailyBudgetMinor: number;
  updatedDaysAgo: number;
  metaFailed: boolean;
}

const SPECS: CampaignSpec[] = [
  {
    slug: 'live-potenzialanalyse',
    name: 'Potenzialanalyse Handwerk — Q3',
    state: 'LIVE',
    angleName: 'Planbare Anfragen statt Empfehlungsglück',
    offerName: 'Kostenlose Potenzialanalyse',
    granted: ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'],
    invalidated: [],
    approvedConcepts: ['concept_1', 'concept_2', 'concept_3', 'concept_4', 'concept_6'],
    collision: null,
    hasPerformance: true,
    dailyBudgetMinor: 12_000,
    updatedDaysAgo: 0,
    metaFailed: false,
  },
  {
    slug: 'meta-entwurf-benchmark',
    name: 'Benchmark Metallbau — Pilot',
    state: 'META_DRAFT_CREATED',
    angleName: 'Der eigene Betrieb im Branchenvergleich',
    offerName: 'Benchmark-Report',
    granted: ['STRATEGY', 'ASSETS', 'TEST_PLAN'],
    invalidated: [],
    approvedConcepts: ['concept_1', 'concept_2', 'concept_3', 'concept_5', 'concept_6'],
    collision: null,
    hasPerformance: false,
    dailyBudgetMinor: 8_000,
    updatedDaysAgo: 2,
    metaFailed: false,
  },
  {
    slug: 'assets-in-pruefung',
    name: 'Auslastungslücke Elektro — Test 2',
    state: 'ASSET_REVIEW',
    angleName: 'Die Lücke zwischen zwei Großaufträgen',
    offerName: 'Individueller Audit',
    granted: ['STRATEGY'],
    invalidated: [],
    approvedConcepts: ['concept_1', 'concept_3', 'concept_4', 'concept_2', 'concept_5'],
    collision: ['concept_2', 'concept_5'],
    hasPerformance: false,
    dailyBudgetMinor: 6_000,
    updatedDaysAgo: 1,
    metaFailed: false,
  },
  {
    slug: 'claim-nachtraeglich-geaendert',
    name: 'Fenstermontage Förderung — Nachtrag',
    state: 'TEST_PLAN_REVIEW',
    angleName: 'Förderung nutzen, bevor sie ausläuft',
    offerName: 'Checkliste Förderung',
    granted: ['STRATEGY', 'ASSETS', 'TEST_PLAN'],
    invalidated: ['STRATEGY'],
    approvedConcepts: ['concept_1', 'concept_2', 'concept_3', 'concept_4', 'concept_5'],
    collision: null,
    hasPerformance: false,
    dailyBudgetMinor: 7_000,
    updatedDaysAgo: 3,
    metaFailed: false,
  },
  {
    slug: 'strategie-in-pruefung',
    name: 'Nachfolge im Handwerk — Idee',
    state: 'STRATEGY_REVIEW',
    angleName: 'Nachfolge planen, bevor sie drängt',
    offerName: 'Strategiegespräch',
    granted: [],
    invalidated: [],
    approvedConcepts: [],
    collision: null,
    hasPerformance: false,
    dailyBudgetMinor: 5_000,
    updatedDaysAgo: 4,
    metaFailed: false,
  },
  {
    slug: 'pausiert-sanitaer',
    name: 'Sanitär Notdienst — Sommerwelle',
    state: 'PAUSED',
    angleName: 'Planbare Anfragen statt Empfehlungsglück',
    offerName: 'Kostenlose Potenzialanalyse',
    granted: ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'],
    invalidated: [],
    approvedConcepts: ['concept_1', 'concept_2', 'concept_4', 'concept_5', 'concept_6'],
    collision: null,
    hasPerformance: true,
    dailyBudgetMinor: 4_000,
    updatedDaysAgo: 9,
    metaFailed: true,
  },
  {
    slug: 'abgeschlossen-dach',
    name: 'Dachsanierung Förderung — Q2',
    state: 'COMPLETED',
    angleName: 'Förderung nutzen, bevor sie ausläuft',
    offerName: 'Checkliste Förderung',
    granted: ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'],
    invalidated: [],
    approvedConcepts: ['concept_1', 'concept_2', 'concept_3', 'concept_4', 'concept_5'],
    collision: null,
    hasPerformance: true,
    dailyBudgetMinor: 9_000,
    updatedDaysAgo: 34,
    metaFailed: false,
  },
];

interface CampaignRecord {
  id: string;
  spec: CampaignSpec;
  state: CampaignState;
  dailyBudgetMinor: number;
  approvals: Map<ApprovalKind, Approval>;
  creativeReview: Map<string, { state: AssetReviewState; by: string | null; at: string | null; reasonDe: string | null }>;
  audit: AuditLog[];
  commands: Map<string, ExternalCommand>;
  leadSync: Map<string, { status: LeadRow['syncStatus']; attempts: number; error: string | null }>;
  /** Operator verdicts, keyed by recommendation id. Purely our own record. */
  recommendationDecisions: Map<string, { state: RecommendationState; reasonDe: string | null }>;
  updatedAt: string;
}

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

const APPROVAL_INVALIDATION_REASON_DE =
  'Nach der Freigabe wurde der Claim „Eine vorgezogene Qualifizierung senkt die No-Show-Quote spürbar." geändert. Die Freigabe deckt den aktuellen Stand nicht mehr ab und muss erneut erteilt werden.';

function buildApproval(
  record: { id: string; spec: CampaignSpec },
  kind: ApprovalKind,
  contentHash: string,
): Approval {
  const spec = record.spec;
  const granted = spec.granted.includes(kind);
  const invalidated = spec.invalidated.includes(kind);
  const base: Approval = {
    id: fixtureUuid(`${spec.slug}:approval:${kind}`),
    campaign_id: record.id,
    kind,
    state: 'PENDING',
    approved_content_hash: null,
    approved_by: null,
    approved_at: null,
    rejected_reason_de: null,
    invalidated_at: null,
    invalidated_reason_de: null,
    created_at: iso(-spec.updatedDaysAgo - 12),
  };
  if (!granted) return base;
  return {
    ...base,
    state: invalidated ? 'INVALIDATED' : 'APPROVED',
    // An invalidated approval keeps the hash it was granted against: that is
    // exactly what makes the mismatch visible instead of silently healing.
    approved_content_hash: invalidated ? fixtureContentHash({ stale: kind }) : contentHash,
    approved_by: fixtureUuid('user:lead'),
    approved_at: iso(-spec.updatedDaysAgo - 3),
    invalidated_at: invalidated ? iso(-spec.updatedDaysAgo - 1) : null,
    invalidated_reason_de: invalidated ? APPROVAL_INVALIDATION_REASON_DE : null,
  };
}

/**
 * Stable ids of the fixture campaigns, exported so the console's own tests and
 * the E2E suite can address the deterministic dataset by name.
 */
export const FIXTURE_CAMPAIGN_IDS = {
  live: fixtureUuid('campaign:live-potenzialanalyse'),
  metaDraft: fixtureUuid('campaign:meta-entwurf-benchmark'),
  assetReview: fixtureUuid('campaign:assets-in-pruefung'),
  strategyReview: fixtureUuid('campaign:strategie-in-pruefung'),
  invalidatedApproval: fixtureUuid('campaign:claim-nachtraeglich-geaendert'),
  paused: fixtureUuid('campaign:pausiert-sanitaer'),
  completed: fixtureUuid('campaign:abgeschlossen-dach'),
} as const;

const STORE = new Map<string, CampaignRecord>();

function reviewStateFor(spec: CampaignSpec, key: string): AssetReviewState {
  if (spec.approvedConcepts.includes(key)) return 'APPROVED';
  if (spec.collision && spec.collision.includes(key)) return 'IN_REVIEW';
  return spec.granted.includes('ASSETS') ? 'IN_REVIEW' : 'DRAFT';
}

function seedStore(): void {
  if (STORE.size > 0) return;
  for (const spec of SPECS) {
    const id = fixtureUuid(`campaign:${spec.slug}`);
    const partial = { id, spec };
    const approvals = new Map<ApprovalKind, Approval>();
    for (const kind of ['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'] as ApprovalKind[]) {
      approvals.set(kind, buildApproval(partial, kind, hashFor(spec, kind)));
    }

    const creativeReview = new Map<
      string,
      { state: AssetReviewState; by: string | null; at: string | null; reasonDe: string | null }
    >();
    for (const concept of CONCEPTS) {
      const state = reviewStateFor(spec, concept.key);
      creativeReview.set(concept.key, {
        state,
        by: state === 'APPROVED' ? 'Marketing Lead' : null,
        at: state === 'APPROVED' ? iso(-spec.updatedDaysAgo - 2) : null,
        reasonDe: null,
      });
    }

    const leadSync = new Map<string, { status: LeadRow['syncStatus']; attempts: number; error: string | null }>();
    if (spec.hasPerformance) {
      for (let i = 0; i < LEAD_COUNT; i += 1) {
        const leadId = fixtureUuid(`${spec.slug}:lead:${i}`);
        const bucket = i % 9;
        leadSync.set(
          leadId,
          bucket === 3
            ? {
                status: 'FAILED_RETRYING',
                attempts: 3,
                error: 'HubSpot antwortete mit 429 (Rate Limit). Wiederholung geplant.',
              }
            : bucket === 7
              ? { status: 'PENDING', attempts: 0, error: null }
              : { status: 'SYNCED', attempts: 1, error: null },
        );
      }
    }

    STORE.set(id, {
      id,
      spec,
      state: spec.state,
      dailyBudgetMinor: spec.dailyBudgetMinor,
      approvals,
      creativeReview,
      audit: buildAudit(id, spec),
      commands: buildCommands(id, spec),
      leadSync,
      recommendationDecisions: new Map(),
      updatedAt: iso(-spec.updatedDaysAgo),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Content hashes                                                              */
/* -------------------------------------------------------------------------- */

function strategyContent(spec: CampaignSpec): StrategyContent {
  return {
    angle: spec.angleName,
    offer: spec.offerName,
    claims: CLAIMS.map((c) => c.text),
    coreMessage: coreMessageFor(spec),
    // The fixture holds no campaign version rows; the repository-backed port
    // fills this from `campaign_versions.content_hash`.
    versionHash: null,
  };
}

function assetsContent(approved: string[]): AssetsContent {
  return { creatives: approved, funnels: FUNNEL_PROPOSALS.map((f) => f.key) };
}

function testPlanContent(spec: CampaignSpec, dailyBudgetMinor: number): TestPlanContent {
  return { plan: spec.slug, dailyBudgetMinor };
}

function hashFor(spec: CampaignSpec, kind: ApprovalKind): string {
  switch (kind) {
    case 'STRATEGY':
      return strategyContentHash(strategyContent(spec));
    case 'ASSETS':
      return assetsContentHash(assetsContent(spec.approvedConcepts));
    case 'TEST_PLAN':
      return testPlanContentHash(testPlanContent(spec, spec.dailyBudgetMinor));
    default:
      return publishContentHash({ publish: spec.slug });
  }
}

function currentHash(record: CampaignRecord, kind: ApprovalKind): string {
  switch (kind) {
    case 'STRATEGY':
      return strategyContentHash(strategyContent(record.spec));
    case 'ASSETS':
      return assetsContentHash(assetsContent(approvedConceptKeys(record)));
    case 'TEST_PLAN':
      return testPlanContentHash(testPlanContent(record.spec, record.dailyBudgetMinor));
    default:
      return publishContentHash({ publish: record.spec.slug });
  }
}

function approvedConceptKeys(record: CampaignRecord): string[] {
  return [...record.creativeReview.entries()]
    .filter(([, value]) => value.state === 'APPROVED')
    .map(([key]) => key)
    .sort();
}

function coreMessageFor(spec: CampaignSpec): string {
  return `${spec.angleName}: Wer die Qualifizierung vor den Termin zieht, bekommt planbare Auslastung statt zufälliger Empfehlungen.`;
}

/* -------------------------------------------------------------------------- */
/* Audit and commands                                                          */
/* -------------------------------------------------------------------------- */

function auditRow(
  id: string,
  spec: CampaignSpec,
  index: number,
  action: AuditAction,
  summaryDe: string,
  before: unknown,
  after: unknown,
): AuditLog {
  return {
    id: fixtureUuid(`${spec.slug}:audit:${index}`),
    workspace_id: WORKSPACE_ID,
    action,
    occurred_at: iso(-spec.updatedDaysAgo - (10 - index)),
    actor_id: fixtureUuid('user:lead'),
    actor_label: index % 3 === 0 ? 'System (Pipeline)' : 'Marvin Flenche',
    entity_type: 'campaign',
    entity_id: id,
    campaign_id: id,
    summaryDe,
    before,
    after,
    correlation_id: `fixture:${spec.slug}:${index}`,
  };
}

function buildAudit(id: string, spec: CampaignSpec): AuditLog[] {
  const rows: AuditLog[] = [
    auditRow(id, spec, 0, 'campaign.created', 'Kampagne angelegt.', null, { name: spec.name }),
    auditRow(id, spec, 1, 'proposal.generated', 'Kampagnenvorschlag erzeugt (6 Creatives, 3 Funnel).', null, {
      creativeConcepts: 6,
      funnelProposals: 3,
    }),
  ];
  if (spec.granted.includes('STRATEGY')) {
    rows.push(
      auditRow(id, spec, 2, 'approval.granted', 'Freigabe „Strategie" erteilt.', { state: 'PENDING' }, { state: 'APPROVED' }),
    );
  }
  if (spec.invalidated.includes('STRATEGY')) {
    rows.push(
      auditRow(
        id,
        spec,
        3,
        'claim.changed',
        'Claim geändert — Strategiefreigabe dadurch ungültig geworden.',
        { claim: 'Eine vorgezogene Qualifizierung senkt die No-Show-Quote um 30 %.' },
        { claim: 'Eine vorgezogene Qualifizierung senkt die No-Show-Quote spürbar.' },
      ),
      auditRow(id, spec, 4, 'approval.invalidated', 'Freigabe „Strategie" durch Änderung ungültig.', { state: 'APPROVED' }, { state: 'INVALIDATED' }),
    );
  }
  if (spec.granted.includes('ASSETS')) {
    rows.push(
      auditRow(id, spec, 5, 'creative.approved', 'Fünf Creatives freigegeben.', { approved: 0 }, { approved: 5 }),
    );
  }
  if (spec.granted.includes('TEST_PLAN')) {
    rows.push(
      auditRow(id, spec, 6, 'launch_qa.evaluated', 'Launch-QA ausgeführt.', null, { checks: LAUNCH_CHECK_KEYS.length }),
    );
  }
  if (spec.state === 'META_DRAFT_CREATED' || spec.hasPerformance) {
    rows.push(
      auditRow(
        id,
        spec,
        7,
        'meta.command_requested',
        'Pausierter Meta-Entwurf angefordert.',
        null,
        { kind: 'CREATE_DRAFT_CAMPAIGN', status: 'PAUSED' },
      ),
    );
  }
  if (spec.hasPerformance) {
    rows.push(
      auditRow(id, spec, 8, 'campaign.state_changed', 'Status auf „Live" gesetzt.', { state: 'SCHEDULED' }, { state: 'LIVE' }),
      auditRow(id, spec, 9, 'recommendation.generated', 'Drei Empfehlungen erzeugt.', null, { count: 3 }),
    );
  }
  return rows.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
}

/**
 * One list, newest first, out of the seeded chain and the rows the audit store
 * holds. Deduplicated by id, so that once the port reads its own history from
 * that same store a row arriving from both sides is still rendered once.
 */
export function mergeAuditLog(
  seeded: readonly AuditLog[],
  recorded: readonly AuditLog[],
): AuditLog[] {
  const byId = new Map<string, AuditLog>();
  for (const row of [...seeded, ...recorded]) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
}

/**
 * Object ids belonging to the fixture dataset.
 *
 * They are the fixture's own data and never a claim that these objects exist in
 * an ad account — nothing in this deployment is connected to Meta. They live
 * here once so a preview, a payload and a command can never name different
 * objects for the same action.
 */
const FIXTURE_META_CAMPAIGN_ID = '120214880031240500';
const FIXTURE_META_AD_ID = '120214880031240521';

function buildCommands(id: string, spec: CampaignSpec): Map<string, ExternalCommand> {
  const map = new Map<string, ExternalCommand>();
  if (!spec.hasPerformance) return map;
  const recId = fixtureUuid(`${spec.slug}:rec:pause-creative`);
  map.set(recId, {
    id: fixtureUuid(`${spec.slug}:cmd:pause-creative`),
    provider: 'META',
    kind: 'PAUSE_CREATIVE',
    idempotencyKey: `fixture-${spec.slug}-pause-creative`,
    state: 'PROVIDER_CONFIRMED',
    requestedBy: fixtureUuid('user:lead'),
    requestedAt: iso(-2),
    confirmedAt: iso(-2, 1),
    reconciledAt: null,
    requestPreview: {
      ad_id: FIXTURE_META_AD_ID,
      status: 'PAUSED',
    },
    providerResponseRedacted: { success: true, id: FIXTURE_META_AD_ID },
    error: null,
    attemptCount: 1,
    campaign_id: id,
  });
  return map;
}

/* -------------------------------------------------------------------------- */
/* Derived views                                                               */
/* -------------------------------------------------------------------------- */

export function realityOf(state: CampaignState, preview: boolean): CampaignReality {
  if (preview) return 'PREVIEW';
  switch (state) {
    case 'META_DRAFT_CREATED':
    case 'SCHEDULED':
      return 'META_DRAFT_PAUSED';
    case 'LIVE':
      return 'LIVE';
    case 'PAUSED':
      return 'PAUSED';
    case 'COMPLETED':
    case 'ARCHIVED':
      return 'ENDED';
    default:
      return 'DRAFT';
  }
}

/* -------------------------------------------------------------------------- */
/* Meta-side writes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The two state changes only Meta can make true.
 *
 * Entering `META_DRAFT_CREATED` means a campaign, its ad sets and its ads were
 * created in the ad account; entering `LIVE` means they were resumed. Both are
 * statements about the provider's records, so both go through the Meta write
 * path — with writes disabled they produce a `DryRunResult` and the state is
 * left untouched, because a state whose name asserts a Meta object may not rest
 * on a local click (AGENTS.md rules 2 and 3).
 *
 * `SCHEDULED` is deliberately absent: it records a planned start next to a
 * draft that was already created, and changes nothing over there.
 */
const META_WRITING_TRANSITIONS = {
  META_DRAFT_CREATED: 'meta.create_paused_draft_campaign',
  LIVE: 'meta.resume_entity',
} as const satisfies Partial<Record<CampaignState, string>>;

function isMetaWritingTransition(to: CampaignState): to is keyof typeof META_WRITING_TRANSITIONS {
  return to in META_WRITING_TRANSITIONS;
}

/**
 * Whether the daily budget of this campaign is a number in an ad account rather
 * than a planning figure in our own record. From the paused draft onwards it is
 * the former, so changing it is an external write.
 */
function budgetLivesAtMeta(state: CampaignState): boolean {
  const reality = realityOf(state, false);
  return reality === 'META_DRAFT_PAUSED' || reality === 'LIVE' || reality === 'PAUSED';
}

function draftIdempotencyKey(record: CampaignRecord): string {
  return `campaign-draft-${record.spec.slug}`;
}

/**
 * Exactly what creating the paused draft would send.
 *
 * Every object is `PAUSED`, and the ids that can only come from a connected ad
 * account are `null` rather than filled in — an invented account, page or pixel
 * id in a preview is a fabricated external fact even when nothing is sent.
 */
function draftRequestPayload(record: CampaignRecord): Record<string, unknown> {
  const key = draftIdempotencyKey(record);
  const name = `AM | ${record.spec.name}`;
  return {
    ad_account_id: null,
    page_id: null,
    pixel_id: null,
    idempotency_key: key,
    campaign: {
      name: draftNameWithMarker(name, key),
      objective: 'OUTCOME_LEADS',
      status: 'PAUSED',
      special_ad_categories: [],
      daily_budget: record.dailyBudgetMinor,
      currency: 'EUR',
    },
    ad_sets: FUNNEL_PROPOSALS.map((proposal) => ({
      name: `${name} | ${proposal.name}`,
      status: 'PAUSED',
    })),
    ads: approvedConceptKeys(record).map((key) => ({
      name: `${name} | ${CONCEPTS.find((c) => c.key === key)?.name ?? key}`,
      status: 'PAUSED',
    })),
  };
}

/** What each publishing step on the Launch-QA screen would send to Meta. */
function metaWritePreviews(record: CampaignRecord): MetaWritePreview[] {
  return [
    {
      to: 'META_DRAFT_CREATED',
      operation: META_WRITING_TRANSITIONS.META_DRAFT_CREATED,
      payload: draftRequestPayload(record),
    },
    {
      to: 'LIVE',
      operation: META_WRITING_TRANSITIONS.LIVE,
      payload: {
        campaign_id: FIXTURE_META_CAMPAIGN_ID,
        status: 'ACTIVE',
        daily_budget: record.dailyBudgetMinor,
        currency: 'EUR',
      },
    },
  ];
}

/** The payload a daily-budget change would send, in the shape Meta expects. */
function budgetRequestPayload(newDailyBudgetMinor: number): Record<string, unknown> {
  return {
    campaign_id: FIXTURE_META_CAMPAIGN_ID,
    daily_budget: newDailyBudgetMinor,
    currency: 'EUR',
  };
}

function approvalStatus(record: CampaignRecord, kind: ApprovalKind): ApprovalStatus {
  const approval = record.approvals.get(kind)!;
  const hash = currentHash(record, kind);
  const valid = isApprovalValid(approval, hash);
  return {
    kind,
    approval,
    currentContentHash: hash,
    valid,
    approverName: approval.approved_by ? 'Marvin Flenche' : null,
    invalidatedByDe:
      approval.state === 'APPROVED' && !valid
        ? APPROVAL_INVALIDATION_REASON_DE
        : (approval.invalidated_reason_de ?? null),
  };
}

function allApprovals(record: CampaignRecord): ApprovalStatus[] {
  return (['STRATEGY', 'ASSETS', 'TEST_PLAN', 'PUBLISH'] as ApprovalKind[]).map((kind) =>
    approvalStatus(record, kind),
  );
}

const LEAD_COUNT = 18;

function diversityOf(record: CampaignRecord): DiversityCheckView {
  const collision = record.spec.collision;
  const required = GENERATION_DEFAULTS.minApprovedCreatives;
  if (!collision) {
    return {
      distinctCount: CONCEPTS.length,
      requiredDistinct: required,
      blocked: false,
      reasonsDe: [],
      collisions: [],
      evaluatedAt: iso(-record.spec.updatedDaysAgo),
    };
  }
  const [aKey, bKey] = collision;
  const a = CONCEPTS.find((c) => c.key === aKey)!;
  const b = CONCEPTS.find((c) => c.key === bKey)!;
  const distinct = CONCEPTS.length - 2;
  return {
    distinctCount: distinct,
    requiredDistinct: required,
    blocked: distinct < required,
    reasonsDe: [
      `Nur ${distinct} von ${CONCEPTS.length} Konzepten sind konzeptionell unterschiedlich, erforderlich sind ${required}.`,
      'Zwei Konzepte erzählen dieselbe Idee und zählen deshalb als eines.',
    ],
    collisions: [
      {
        aKey,
        aName: a.name,
        bKey,
        bName: b.name,
        overall: 0.71,
        samePrinciple: a.principle === b.principle,
        reasonDe: `„${a.name}" und „${b.name}" sind sich in Aufhänger und Funnel-Versprechen zu ähnlich (Gesamtähnlichkeit 71 %, Schwelle 55 %). Ersetzen Sie eines der beiden Konzepte, bevor Sie die Assets freigeben.`,
      },
    ],
    evaluatedAt: iso(-record.spec.updatedDaysAgo),
  };
}

function launchChecks(record: CampaignRecord): LaunchCheckResult[] {
  const id = record.id;
  const approved = approvedConceptKeys(record);
  const diversity = diversityOf(record);
  const approvals = new Map(allApprovals(record).map((a) => [a.kind, a]));
  const strategyOk = approvals.get('STRATEGY')?.valid === true;
  const assetsOk = approvals.get('ASSETS')?.valid === true;
  const planOk = approvals.get('TEST_PLAN')?.valid === true;

  const href = (tab: Parameters<typeof campaignTabHref>[1]) => campaignTabHref(id, tab);

  const status = (
    key: (typeof LAUNCH_CHECK_KEYS)[number],
  ): { status: HealthStatus; detailDe: string; remediationDe: string | null; href: string } => {
    switch (key) {
      case 'angle_approved':
      case 'offer_approved':
      case 'claims_approved':
        return strategyOk
          ? { status: 'PASS', detailDe: 'Freigabe „Strategie" liegt vor und deckt den aktuellen Stand.', remediationDe: null, href: href('strategie') }
          : {
              status: 'FAIL',
              detailDe: 'Die Strategiefreigabe fehlt oder ist durch eine Änderung ungültig geworden.',
              remediationDe: 'Strategie prüfen und erneut freigeben.',
              href: href('strategie'),
            };
      case 'creatives_approved':
        return approved.length >= GENERATION_DEFAULTS.minApprovedCreatives
          ? {
              status: 'PASS',
              detailDe: `${approved.length} von ${CONCEPTS.length} Creatives freigegeben.`,
              remediationDe: null,
              href: href('creatives'),
            }
          : {
              status: 'FAIL',
              detailDe: `Nur ${approved.length} von mindestens ${GENERATION_DEFAULTS.minApprovedCreatives} erforderlichen Creatives sind freigegeben.`,
              remediationDe: 'Fehlende Creatives prüfen und freigeben.',
              href: href('creatives'),
            };
      case 'creatives_distinct':
        return diversity.blocked
          ? {
              status: 'FAIL',
              detailDe: diversity.reasonsDe[0] ?? 'Zu wenige konzeptionell unterschiedliche Creatives.',
              remediationDe: 'Eines der kollidierenden Konzepte ersetzen.',
              href: href('creatives'),
            }
          : {
              status: 'PASS',
              detailDe: `${diversity.distinctCount} konzeptionell unterschiedliche Creatives.`,
              remediationDe: null,
              href: href('creatives'),
            };
      case 'funnel_versions_published':
        return assetsOk
          ? { status: 'PASS', detailDe: 'Drei Funnel-Versionen veröffentlicht.', remediationDe: null, href: href('funnel') }
          : {
              status: 'WARN',
              detailDe: 'Eine Funnel-Version ist noch ein Entwurf.',
              remediationDe: 'Funnel-Version im Builder veröffentlichen.',
              href: href('funnel'),
            };
      case 'experiment_plan_complete':
      case 'primary_metric_defined':
      case 'min_volume_defined':
      case 'budget_and_limits_defined':
        return planOk
          ? { status: 'PASS', detailDe: 'Testplan ist vollständig und freigegeben.', remediationDe: null, href: href('testplan') }
          : {
              status: 'FAIL',
              detailDe: 'Der Testplan ist nicht freigegeben.',
              remediationDe: 'Testplan prüfen und freigeben.',
              href: href('testplan'),
            };
      case 'target_urls_reachable':
      case 'variant_assignment_working':
      case 'event_tracking_working':
        return {
          status: 'PASS',
          detailDe: 'Gegen die Fixture-Umgebung geprüft.',
          remediationDe: null,
          href: href('funnel'),
        };
      case 'consent_version_set':
        return {
          status: 'PASS',
          detailDe: 'Consent-Version 3 ist hinterlegt.',
          remediationDe: null,
          href: '/einstellungen',
        };
      case 'no_critical_sync_errors':
        return record.spec.metaFailed
          ? {
              status: 'FAIL',
              detailDe: 'Ein Meta-Sync ist fehlgeschlagen und wurde noch nicht abgeglichen.',
              remediationDe: 'Fehlerhafte Synchronisation unter Integrationen prüfen und erneut ausführen.',
              href: '/integrationen',
            }
          : { status: 'PASS', detailDe: 'Keine kritischen Syncfehler.', remediationDe: null, href: '/integrationen' };
      case 'hubspot_mapping_complete':
        return {
          status: 'AWAITING_EXTERNAL_INPUT',
          detailDe: 'Das HubSpot-Pflichtmapping wurde noch nicht vom Kunden bestätigt.',
          remediationDe: 'Mapping-Assistenten mit RevOps durchgehen, sobald die Property-Namen vorliegen.',
          href: '/integrationen',
        };
      case 'hubspot_test_lead_successful':
        return {
          status: 'AWAITING_EXTERNAL_INPUT',
          detailDe: 'Ohne bestätigtes Mapping kann kein Test-Lead gesendet werden.',
          remediationDe: 'Zuerst das HubSpot-Mapping abschließen.',
          href: '/integrationen',
        };
      case 'contact_deal_association_verified':
        return {
          status: 'AWAITING_EXTERNAL_INPUT',
          detailDe: 'Die Contact-/Deal-Association ist erst nach einem echten Test-Lead prüfbar.',
          remediationDe: 'Nach dem Test-Lead erneut prüfen.',
          href: '/integrationen',
        };
      case 'meta_permissions_valid':
        return {
          status: 'AWAITING_EXTERNAL_INPUT',
          detailDe: 'Es liegt kein Meta-Zugriffstoken vor; die Berechtigungen sind nicht prüfbar.',
          remediationDe: 'Meta-Werbekonto unter Integrationen verbinden.',
          href: '/integrationen',
        };
      case 'pixel_capi_dedup_tested':
        return {
          status: 'AWAITING_EXTERNAL_INPUT',
          detailDe: 'Die Deduplizierung ist ohne verbundenes Pixel nicht messbar.',
          remediationDe: 'Pixel und Conversions API unter Integrationen verbinden.',
          href: '/integrationen',
        };
      default:
        return { status: 'PASS', detailDe: 'Geprüft.', remediationDe: null, href: href('launch-qa') };
    }
  };

  return LAUNCH_CHECK_KEYS.map((key) => {
    const evaluated = status(key);
    return {
      key,
      labelDe: LAUNCH_CHECK_LABELS_DE[key],
      status: evaluated.status,
      detailDe: evaluated.detailDe,
      remediationDe: evaluated.remediationDe,
      blocksLiveOnly: LIVE_ONLY_CHECKS.includes(key),
      href: evaluated.href,
    };
  });
}

function primaryMetricOf(record: CampaignRecord): MetricValue {
  const spec = record.spec;
  if (!spec.hasPerformance) {
    return {
      metric: 'cpl',
      numerator: null,
      denominator: null,
      value: null,
      currency: 'EUR',
      maturity: 'IMMATURE',
      attributionCoverage: null,
    };
  }
  const totals = performanceTotals(record);
  return {
    metric: 'cpl',
    numerator: totals.spendMinor,
    denominator: totals.submissions,
    value: totals.submissions > 0 ? Math.round(totals.spendMinor / totals.submissions) : null,
    currency: 'EUR',
    maturity: spec.state === 'COMPLETED' ? 'MATURE' : 'PARTIAL',
    attributionCoverage: spec.state === 'COMPLETED' ? 0.91 : 0.83,
  };
}

function providerSyncOf(record: CampaignRecord): ProviderSyncStatus[] {
  const failed = [...record.leadSync.values()].filter((s) => s.status === 'FAILED_RETRYING').length;
  return [
    {
      provider: 'META',
      connection: 'FIXTURE',
      health: record.spec.metaFailed ? 'FAIL' : record.spec.hasPerformance ? 'PASS' : 'AWAITING_EXTERNAL_INPUT',
      detailDe: record.spec.metaFailed
        ? 'Letzte Synchronisation fehlgeschlagen — Statuswechsel wurde nicht bestätigt.'
        : record.spec.hasPerformance
          ? 'Insights aus dem Fixture-Provider, stündlich abgeglichen.'
          : 'Kein Meta-Zugriffstoken hinterlegt; es wird gegen Fixtures gearbeitet.',
      lastSyncedAt: record.spec.hasPerformance ? iso(0, -2) : null,
      failedCount: record.spec.metaFailed ? 1 : 0,
    },
    {
      provider: 'HUBSPOT',
      connection: 'FIXTURE',
      health: failed > 0 ? 'WARN' : record.spec.hasPerformance ? 'PASS' : 'AWAITING_EXTERNAL_INPUT',
      detailDe:
        failed > 0
          ? `${failed} Lead-Übertragungen sind fehlgeschlagen und werden wiederholt.`
          : record.spec.hasPerformance
            ? 'Alle Leads übertragen.'
            : 'Pflichtmapping noch nicht bestätigt; es wird gegen Fixtures gearbeitet.',
      lastSyncedAt: record.spec.hasPerformance ? iso(0, -1) : null,
      failedCount: failed,
    },
  ];
}

function nextActionOf(record: CampaignRecord): NextRequiredAction {
  const id = record.id;
  const approvals = new Map(allApprovals(record).map((a) => [a.kind, a]));
  const strategy = approvals.get('STRATEGY')!;
  const assets = approvals.get('ASSETS')!;
  const plan = approvals.get('TEST_PLAN')!;
  const publish = approvals.get('PUBLISH')!;
  const approvedCount = approvedConceptKeys(record).length;
  const diversity = diversityOf(record);

  if (!strategy.valid) {
    return {
      key: 'approve_strategy',
      labelDe: strategy.approval.state === 'INVALIDATED' || strategy.approval.state === 'APPROVED'
        ? 'Strategie erneut freigeben'
        : 'Strategie freigeben',
      detailDe:
        strategy.approval.state === 'APPROVED' || strategy.approval.state === 'INVALIDATED'
          ? 'Der Inhalt wurde nach der Freigabe geändert. Die Freigabe deckt den aktuellen Stand nicht mehr ab.'
          : 'Angle, Offer und Claims müssen freigegeben werden, bevor Assets erzeugt werden.',
      href: campaignTabHref(id, 'strategie'),
      permission: 'campaign.approve_strategy',
      blocked: false,
      blockedReasonDe: null,
    };
  }

  if (!assets.valid) {
    const blocked = diversity.blocked || approvedCount < GENERATION_DEFAULTS.minApprovedCreatives;
    return {
      key: 'approve_assets',
      labelDe: 'Creatives und Funnel freigeben',
      detailDe: `${approvedCount} von mindestens ${GENERATION_DEFAULTS.minApprovedCreatives} Creatives sind freigegeben.`,
      href: campaignTabHref(id, 'creatives'),
      permission: 'campaign.approve_assets',
      blocked,
      blockedReasonDe: blocked
        ? diversity.blocked
          ? `Nur ${diversity.distinctCount} von ${diversity.requiredDistinct} erforderlichen Creatives sind konzeptionell unterschiedlich.`
          : `Es sind erst ${approvedCount} von ${GENERATION_DEFAULTS.minApprovedCreatives} erforderlichen Creatives freigegeben.`
        : null,
    };
  }

  if (!plan.valid) {
    return {
      key: 'approve_test_plan',
      labelDe: 'Testplan freigeben',
      detailDe: 'Hypothese, Metriken, Mindestvolumen, Stop- und Skalierungsregeln prüfen.',
      href: campaignTabHref(id, 'testplan'),
      permission: 'campaign.approve_test_plan',
      blocked: false,
      blockedReasonDe: null,
    };
  }

  const report = summarizeLaunchQa(id, launchChecks(record), iso(0));

  if (record.state === 'READY_FOR_LAUNCH_QA' || record.state === 'TEST_PLAN_REVIEW') {
    return {
      key: 'run_launch_qa',
      labelDe: 'Launch-QA abschließen',
      detailDe: `${report.blockingDe.length} blockierende Prüfungen, ${report.awaitingExternalDe.length} warten auf externen Input.`,
      href: campaignTabHref(id, 'launch-qa'),
      permission: 'campaign.publish',
      blocked: !report.canCreateMetaDraft,
      blockedReasonDe: report.canCreateMetaDraft ? null : `Blockiert durch: ${report.blockingDe.join(', ')}.`,
    };
  }

  if (record.state === 'READY_FOR_META_DRAFT') {
    return {
      key: 'create_meta_draft',
      labelDe: 'Pausierten Meta-Entwurf erstellen',
      detailDe: 'Der Entwurf wird pausiert angelegt und schaltet nichts live.',
      href: campaignTabHref(id, 'launch-qa'),
      permission: 'campaign.publish',
      blocked: !report.canCreateMetaDraft,
      blockedReasonDe: report.canCreateMetaDraft ? null : `Blockiert durch: ${report.blockingDe.join(', ')}.`,
    };
  }

  if (record.state === 'META_DRAFT_CREATED' || record.state === 'SCHEDULED') {
    if (!publish.valid) {
      return {
        key: 'approve_publish',
        labelDe: 'Veröffentlichung freigeben',
        detailDe: 'Ohne Veröffentlichungsfreigabe bleibt der Meta-Entwurf pausiert.',
        href: campaignTabHref(id, 'launch-qa'),
        permission: 'campaign.publish',
        blocked: !report.canGoLive,
        blockedReasonDe: report.canGoLive
          ? null
          : `Live-Schaltung blockiert: ${[...report.blockingDe, ...report.awaitingExternalDe].join(', ')}.`,
      };
    }
    return {
      key: 'go_live',
      labelDe: 'Kampagne live schalten',
      detailDe: 'Der pausierte Entwurf wird aktiviert.',
      href: campaignTabHref(id, 'launch-qa'),
      permission: 'campaign.publish',
      blocked: !report.canGoLive,
      blockedReasonDe: report.canGoLive
        ? null
        : `Live-Schaltung blockiert: ${[...report.blockingDe, ...report.awaitingExternalDe].join(', ')}.`,
    };
  }

  if (record.state === 'LIVE') {
    return {
      key: 'review_recommendations',
      labelDe: 'Offene Empfehlungen entscheiden',
      detailDe: 'Zwei Empfehlungen warten auf eine Entscheidung.',
      href: campaignTabHref(id, 'empfehlungen'),
      permission: 'recommendation.execute',
      blocked: false,
      blockedReasonDe: null,
    };
  }

  if (record.state === 'PAUSED') {
    return {
      key: 'resume_or_conclude',
      labelDe: 'Fortsetzen oder abschließen',
      detailDe: 'Die Kampagne ist pausiert und liefert keine Impressionen aus.',
      href: campaignTabHref(id, 'live-performance'),
      permission: 'campaign.pause',
      blocked: false,
      blockedReasonDe: null,
    };
  }

  if (record.state === 'COMPLETED') {
    return {
      key: 'review_learnings',
      labelDe: 'Learnings prüfen und archivieren',
      detailDe: 'Die Kampagne ist abgeschlossen; die Learnings sind erzeugt.',
      href: campaignTabHref(id, 'learnings'),
      permission: 'campaign.archive',
      blocked: false,
      blockedReasonDe: null,
    };
  }

  return {
    key: 'advance_state',
    labelDe: 'Nächsten Schritt auslösen',
    detailDe: `Aktueller Status: ${record.state}.`,
    href: campaignTabHref(id, 'strategie'),
    permission: 'campaign.edit',
    blocked: false,
    blockedReasonDe: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Performance                                                                 */
/* -------------------------------------------------------------------------- */

function performanceSeries(record: CampaignRecord): PerformancePoint[] {
  if (!record.spec.hasPerformance) return [];
  const days = record.spec.state === 'COMPLETED' ? 21 : 14;
  const points: PerformancePoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const seed = `${record.spec.slug}:day:${i}`;
    const spendMinor = record.dailyBudgetMinor - seededInt(`${seed}:spend`, 0, 1_800);
    const impressions = seededInt(`${seed}:imp`, 3_400, 6_900);
    const clicks = seededInt(`${seed}:clicks`, 42, 118);
    const sessions = Math.round(clicks * 0.88);
    const formStarts = Math.round(sessions * (0.36 + seededInt(`${seed}:fs`, 0, 9) / 100));
    const submissions = Math.max(0, Math.round(formStarts * (0.31 + seededInt(`${seed}:sub`, 0, 12) / 100)));
    points.push({
      date: isoDate(-i),
      spendMinor,
      impressions,
      clicks,
      sessions,
      formStarts,
      submissions,
      ctr: rate(clicks, impressions),
      cpcMinor: clicks > 0 ? Math.round(spendMinor / clicks) : null,
      cplMinor: submissions > 0 ? Math.round(spendMinor / submissions) : null,
    });
  }
  return points;
}

function performanceTotals(record: CampaignRecord) {
  const series = performanceSeries(record);
  return series.reduce(
    (acc, point) => ({
      spendMinor: acc.spendMinor + point.spendMinor,
      impressions: acc.impressions + point.impressions,
      clicks: acc.clicks + point.clicks,
      sessions: acc.sessions + point.sessions,
      formStarts: acc.formStarts + point.formStarts,
      submissions: acc.submissions + point.submissions,
    }),
    { spendMinor: 0, impressions: 0, clicks: 0, sessions: 0, formStarts: 0, submissions: 0 },
  );
}

function breakdownRows(
  record: CampaignRecord,
  kind: 'creative' | 'funnel',
): PerformanceBreakdownRow[] {
  const totals = performanceTotals(record);
  const items =
    kind === 'creative'
      ? approvedConceptKeys(record).map((key) => ({
          id: key,
          labelDe: CONCEPTS.find((c) => c.key === key)?.name ?? key,
        }))
      : FUNNEL_PROPOSALS.map((f) => ({ id: f.key, labelDe: f.name }));

  if (items.length === 0) return [];
  const weights = items.map((item) => seededInt(`${record.spec.slug}:${item.id}:w`, 8, 24));
  const weightSum = weights.reduce((a, b) => a + b, 0);

  return items.map((item, index) => {
    const share = weights[index] / weightSum;
    const spendMinor = Math.round(totals.spendMinor * share);
    const impressions = Math.round(totals.impressions * share);
    const clicks = Math.round(totals.clicks * share);
    const sessions = Math.round(totals.sessions * share);
    const submissions = Math.round(totals.submissions * share);
    return {
      id: item.id,
      labelDe: item.labelDe,
      spendMinor,
      impressions,
      clicks,
      sessions,
      submissions,
      ctr: rate(clicks, impressions),
      submissionRate: rate(submissions, sessions),
      cplMinor: submissions > 0 ? Math.round(spendMinor / submissions) : null,
      maturity: (submissions >= 20 ? 'MATURE' : submissions >= 8 ? 'PARTIAL' : 'IMMATURE') as DataMaturity,
    };
  });
}

function totalsAsMetrics(record: CampaignRecord): MetricValue[] {
  const totals = performanceTotals(record);
  const maturity: DataMaturity = record.spec.state === 'COMPLETED' ? 'MATURE' : 'PARTIAL';
  const coverage = record.spec.state === 'COMPLETED' ? 0.91 : 0.83;
  const make = (
    metric: MetricKey,
    numerator: number | null,
    denominator: number | null,
    value: number | null,
    currency: string | null,
  ): MetricValue => ({ metric, numerator, denominator, value, currency, maturity, attributionCoverage: coverage });

  return [
    make('spend', totals.spendMinor, null, totals.spendMinor, 'EUR'),
    make('impressions', totals.impressions, null, totals.impressions, null),
    make('link_clicks', totals.clicks, null, totals.clicks, null),
    make('ctr', totals.clicks, totals.impressions, totals.impressions > 0 ? totals.clicks / totals.impressions : null, null),
    make('cpc', totals.spendMinor, totals.clicks, totals.clicks > 0 ? Math.round(totals.spendMinor / totals.clicks) : null, 'EUR'),
    make('funnel_sessions', totals.sessions, null, totals.sessions, null),
    make('form_start_rate', totals.formStarts, totals.sessions, totals.sessions > 0 ? totals.formStarts / totals.sessions : null, null),
    make('submission_rate', totals.submissions, totals.sessions, totals.sessions > 0 ? totals.submissions / totals.sessions : null, null),
    make('leads', totals.submissions, null, totals.submissions, null),
    make(
      'cpl',
      totals.spendMinor,
      totals.submissions,
      totals.submissions > 0 ? Math.round(totals.spendMinor / totals.submissions) : null,
      'EUR',
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* CRM                                                                         */
/* -------------------------------------------------------------------------- */

function crmStages(record: CampaignRecord): CrmFunnelStage[] {
  const totals = performanceTotals(record);
  const leads = totals.submissions;
  const scheduled = Math.round(leads * 0.46);
  const attended = Math.round(scheduled * 0.78);
  const noShow = scheduled - attended;
  const qualified = Math.round(attended * 0.61);
  const opportunities = Math.round(qualified * 0.72);
  const won = Math.round(opportunities * 0.34);
  const lost = opportunities - won;
  const late: DataMaturity = record.spec.state === 'COMPLETED' ? 'MATURE' : 'IMMATURE';
  const mid: DataMaturity = record.spec.state === 'COMPLETED' ? 'MATURE' : 'PARTIAL';
  const coverage = record.spec.state === 'COMPLETED' ? 0.91 : 0.83;

  return [
    { key: 'leads', labelDe: 'Leads', count: leads, conversion: rate(leads, totals.sessions), maturity: 'MATURE', attributionCoverage: coverage },
    { key: 'vq_scheduled', labelDe: 'VQ terminiert', count: scheduled, conversion: rate(scheduled, leads), maturity: mid, attributionCoverage: coverage },
    { key: 'vq_attended', labelDe: 'VQ stattgefunden', count: attended, conversion: rate(attended, scheduled), maturity: mid, attributionCoverage: coverage },
    { key: 'vq_no_show', labelDe: 'No-Show', count: noShow, conversion: rate(noShow, scheduled), maturity: mid, attributionCoverage: coverage },
    { key: 'qualified_vq', labelDe: 'Qualifizierte VQ', count: qualified, conversion: rate(qualified, attended), maturity: mid, attributionCoverage: coverage },
    { key: 'opportunities', labelDe: 'Opportunities', count: opportunities, conversion: rate(opportunities, qualified), maturity: late, attributionCoverage: coverage },
    { key: 'closed_won', labelDe: 'Gewonnen', count: won, conversion: rate(won, opportunities), maturity: late, attributionCoverage: coverage },
    { key: 'closed_lost', labelDe: 'Verloren', count: lost, conversion: rate(lost, opportunities), maturity: late, attributionCoverage: coverage },
  ];
}

const VQ_ROTATION = ['SCHEDULED', 'ATTENDED', 'PASSED', 'NO_SHOW', 'NOT_SCHEDULED', 'REJECTED'] as const;

function leadRows(record: CampaignRecord): LeadRow[] {
  if (!record.spec.hasPerformance) return [];
  const rows: LeadRow[] = [];
  const sizes = ['10–24 MA', '25–49 MA', '50–99 MA', 'unter 10 MA'];
  const trades = ['Elektro', 'Sanitär', 'Metallbau', 'Dachdeckerei', 'Tischlerei'];
  let index = 0;
  for (const [leadId, sync] of record.leadSync) {
    const creative = approvedConceptKeys(record)[index % Math.max(1, approvedConceptKeys(record).length)];
    rows.push({
      id: leadId,
      labelDe: `Lead ${1000 + index} · ${trades[index % trades.length]}, ${sizes[index % sizes.length]}`,
      createdAt: iso(-(index % 12), -(index % 7)),
      vqStatus: VQ_ROTATION[index % VQ_ROTATION.length],
      syncStatus: sync.status,
      syncAttempts: sync.attempts,
      lastSyncError: sync.error,
      attributionLevel: index % 5 === 0 ? 'TRAFFIC_LINKED' : index % 7 === 0 ? 'CREATIVE_ONLY' : 'LEAD_LINKED',
      creativeLabelDe: CONCEPTS.find((c) => c.key === creative)?.name ?? null,
      funnelArmLabelDe: FUNNEL_PROPOSALS[index % FUNNEL_PROPOSALS.length].name,
    });
    index += 1;
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Recommendations                                                             */
/* -------------------------------------------------------------------------- */

function recommendationViews(record: CampaignRecord): RecommendationView[] {
  if (!record.spec.hasPerformance) return [];
  const slug = record.spec.slug;
  const rows = breakdownRows(record, 'creative');
  const worst = rows.length > 0 ? rows.reduce((a, b) => ((a.cplMinor ?? 0) > (b.cplMinor ?? 0) ? a : b)) : null;
  const totals = performanceTotals(record);
  const views: RecommendationView[] = [];

  if (worst) {
    const pauseId = fixtureUuid(`${slug}:rec:pause-creative`);
    const command = record.commands.get(pauseId) ?? null;
    views.push({
      recommendation: {
        id: pauseId,
        campaign_id: record.id,
        experiment_id: null,
        created_at: iso(-3),
        action: 'PAUSE_CREATIVE',
        state: command ? 'EXECUTED' : 'OPEN',
        ruleId: 'PAUSE_CREATIVE_UNDERPERFORMING',
        titleDe: `Creative „${worst.labelDe}" pausieren`,
        summaryDe: `„${worst.labelDe}" liegt beim CPL deutlich über dem Kampagnendurchschnitt und hat den Mindestumfang für eine Aussage erreicht.`,
        explanationDe: null,
        nextHypothesisDe: null,
        facts: [
          {
            metric: 'cpl',
            label: `CPL „${worst.labelDe}"`,
            numerator: worst.spendMinor,
            denominator: worst.submissions,
            value: worst.cplMinor,
            currency: 'EUR',
            comparisonLabel: 'Kampagnendurchschnitt',
            comparisonValue: totals.submissions > 0 ? Math.round(totals.spendMinor / totals.submissions) : null,
          },
          {
            metric: 'submission_rate',
            label: 'Submission-Rate',
            numerator: worst.submissions,
            denominator: worst.sessions,
            value: worst.submissionRate.value,
            currency: null,
            comparisonLabel: 'Kampagnendurchschnitt',
            comparisonValue: totals.sessions > 0 ? totals.submissions / totals.sessions : null,
          },
        ],
        comparisonBasisDe:
          'Verglichen mit dem gewichteten Kampagnendurchschnitt der letzten 14 Tage, gleiche Laufzeit, gleiches Zielgruppen-Setup.',
        maturity: 'PARTIAL',
        attributionCoverage: 0.83,
        uncertaintyDe:
          '95-%-Intervall der Submission-Rate: 2,1 % bis 4,4 %. Der Unterschied zum Durchschnitt ist deutlich, aber die CRM-Ergebnisse dieser Kohorte sind noch nicht reif.',
        risk: 'LOW',
        riskNoteDe: 'Pausieren ist reversibel; die übrigen Creatives decken alle sechs Prinzipien weiterhin ab.',
        affectedMetaObjects: [
          {
            level: 'AD',
            external_id: '120214880031240521',
            name: `AM | ${record.spec.name} | ${worst.labelDe}`,
            currentStatus: 'ACTIVE',
            currentDailyBudgetMinor: null,
            proposedDailyBudgetMinor: null,
          },
        ],
        proposedBudgetChangePct: null,
        execution: command
          ? {
              command_state: command.state,
              executed_at: command.requestedAt,
              executed_by: command.requestedBy,
              provider_confirmed_at: command.confirmedAt,
              error: null,
            }
          : null,
      },
      command,
      lastDryRun: null,
      requestPreview: { ad_id: '120214880031240521', status: 'PAUSED' },
      actionSummaryDe: `Setzt die Anzeige „AM | ${record.spec.name} | ${worst.labelDe}" bei Meta auf PAUSED.`,
    });
  }

  const scaleId = fixtureUuid(`${slug}:rec:scale`);
  const proposed = Math.round(record.dailyBudgetMinor * 1.2);
  views.push({
    recommendation: {
      id: scaleId,
      campaign_id: record.id,
      experiment_id: null,
      created_at: iso(-1),
      action: 'INCREASE_BUDGET',
      state: 'OPEN',
      ruleId: 'SCALE_BUDGET',
      titleDe: 'Tagesbudget um 20 % erhöhen',
      summaryDe:
        'Kosten je qualifiziertem VQ liegen unter dem Zielwert, die Guardrails sind eingehalten und seit der letzten Skalierung sind mehr als 24 Stunden vergangen.',
      explanationDe: null,
      nextHypothesisDe: null,
      facts: [
        {
          metric: 'cost_per_qualified_vq',
          label: 'Kosten je qualifiziertem VQ',
          numerator: totals.spendMinor,
          denominator: Math.max(1, Math.round(totals.submissions * 0.22)),
          value: Math.round(totals.spendMinor / Math.max(1, Math.round(totals.submissions * 0.22))),
          currency: 'EUR',
          comparisonLabel: 'Zielwert',
          comparisonValue: 24_000,
        },
        {
          metric: 'submission_rate',
          label: 'Submission-Rate',
          numerator: totals.submissions,
          denominator: totals.sessions,
          value: totals.sessions > 0 ? totals.submissions / totals.sessions : null,
          currency: null,
          comparisonLabel: 'Guardrail-Untergrenze',
          comparisonValue: 0.02,
        },
      ],
      comparisonBasisDe:
        'Verglichen mit dem hinterlegten Zielwert für Kosten je qualifiziertem VQ und der Guardrail-Untergrenze der Submission-Rate.',
      maturity: 'PARTIAL',
      attributionCoverage: 0.83,
      uncertaintyDe:
        'Die CRM-Ergebnisse der letzten sieben Tage sind noch nicht reif. Der Vorschlag stützt sich auf die reifen Kohorten davor.',
      risk: 'MEDIUM',
      riskNoteDe:
        'Eine Erhöhung um 20 % liegt innerhalb des Limits für Marketing Lead. Der Effekt ist frühestens nach 48 Stunden ablesbar.',
      affectedMetaObjects: [
        {
          level: 'CAMPAIGN',
          external_id: '120214880031240500',
          name: `AM | ${record.spec.name}`,
          currentStatus: record.state === 'LIVE' ? 'ACTIVE' : 'PAUSED',
          currentDailyBudgetMinor: record.dailyBudgetMinor,
          proposedDailyBudgetMinor: proposed,
        },
      ],
      proposedBudgetChangePct: 0.2,
      execution: null,
    },
    command: null,
    lastDryRun: null,
    requestPreview: {
      campaign_id: '120214880031240500',
      daily_budget: proposed,
      currency: 'EUR',
    },
    actionSummaryDe: `Erhöht das Tagesbudget der Meta-Kampagne „AM | ${record.spec.name}" von ${(record.dailyBudgetMinor / 100).toFixed(2)} € auf ${(proposed / 100).toFixed(2)} €.`,
  });

  views.push({
    recommendation: {
      id: fixtureUuid(`${slug}:rec:collect`),
      campaign_id: record.id,
      experiment_id: null,
      created_at: iso(-1, -6),
      action: 'COLLECT_MORE_DATA',
      state: 'OPEN',
      ruleId: 'COLLECT_MORE_DATA',
      titleDe: 'Funnelarm „Landingpage mit Direktkontakt" weiterlaufen lassen',
      summaryDe:
        'Der Arm hat das Mindestvolumen je Arm noch nicht erreicht. Eine Entscheidung wäre zum jetzigen Zeitpunkt nicht belastbar.',
      explanationDe: null,
      nextHypothesisDe: null,
      facts: [
        {
          metric: 'funnel_sessions',
          label: 'Sessions im Arm',
          numerator: 132,
          denominator: 200,
          value: 132,
          currency: null,
          comparisonLabel: 'Mindestvolumen je Arm',
          comparisonValue: 200,
        },
      ],
      comparisonBasisDe: 'Verglichen mit dem im Testplan hinterlegten Mindestvolumen von 200 Sessions je Arm.',
      maturity: 'IMMATURE',
      attributionCoverage: 0.79,
      uncertaintyDe: 'Bei 132 Sessions ist das Konfidenzintervall so breit, dass jede Richtung möglich bleibt.',
      risk: 'LOW',
      riskNoteDe: null,
      affectedMetaObjects: [],
      proposedBudgetChangePct: null,
      execution: null,
    },
    command: null,
    lastDryRun: null,
    requestPreview: {},
    actionSummaryDe: 'Keine externe Aktion — der Arm läuft unverändert weiter.',
  });

  // The operator's verdict is the last word on a recommendation's state, so it
  // is applied after the rules produced them rather than woven into each one.
  return views.map((view) => {
    const decision = record.recommendationDecisions.get(view.recommendation.id);
    return decision
      ? { ...view, recommendation: { ...view.recommendation, state: decision.state } }
      : view;
  });
}

/* -------------------------------------------------------------------------- */
/* Learnings                                                                   */
/* -------------------------------------------------------------------------- */

function learningsOf(record: CampaignRecord): LearningCard[] {
  if (!record.spec.hasPerformance) return [];
  const totals = performanceTotals(record);
  const mature = record.spec.state === 'COMPLETED';
  const base = {
    campaign_id: record.id,
    experiment_id: null,
    angleName: record.spec.angleName,
    angle_id: FIXTURE_IDS.angleId,
    offerName: record.spec.offerName,
    offer_id: FIXTURE_IDS.offerId,
    audienceDe: 'Geschäftsführung Handwerksbetriebe, 10–99 Mitarbeitende, Deutschland',
    periodStart: iso(-21),
    periodEnd: iso(0),
    spendMinor: totals.spendMinor,
    currency: 'EUR',
    attributionLevel: (mature ? 'REVENUE_LINKED' : 'LEAD_LINKED') as LearningCard['attributionLevel'],
    attributionCoverage: mature ? 0.91 : 0.62,
  };

  return [
    {
      ...base,
      id: fixtureUuid(`${record.spec.slug}:learning:1`),
      version: 2,
      created_at: iso(-1),
      titleDe: 'Sechs Qualifizierungsfragen schlagen vier bei der Terminqualität',
      whatWasTestedDe:
        'Zwei Multi-Step-Formulare mit identischem Angle und Offer, die sich nur in der Anzahl der Qualifizierungsfragen unterschieden (sechs gegen vier).',
      creativeConceptDe: 'Alle fünf freigegebenen Konzepte, gleichmäßig auf beide Arme verteilt.',
      funnelKind: 'MULTI_STEP_FORM',
      outcomeDe:
        'Der Arm mit sechs Fragen erzeugte weniger Leads, aber einen höheren Anteil qualifizierter VQs. Der Unterschied überstand die Mindestvolumenprüfung.',
      outcomeFacts: [
        { label: 'Submission-Rate sechs Fragen', numerator: 61, denominator: 1_842, value: 61 / 1_842, unit: 'RATE' },
        { label: 'Submission-Rate vier Fragen', numerator: 88, denominator: 1_903, value: 88 / 1_903, unit: 'RATE' },
        { label: 'Qualifizierte VQ sechs Fragen', numerator: 19, denominator: 61, value: 19 / 61, unit: 'RATE' },
        { label: 'Qualifizierte VQ vier Fragen', numerator: 16, denominator: 88, value: 16 / 88, unit: 'RATE' },
      ],
      dataMaturity: mature ? 'MATURE' : 'PARTIAL',
      possibleExplanationDe:
        'Die zusätzlichen Fragen filtern Betriebe heraus, für die das Angebot ohnehin nicht passt — der Verlust an Leads ist überwiegend ein Verlust an unpassenden Leads.',
      suggestedNextTestDe:
        'Sieben Fragen gegen sechs testen, um zu prüfen, ab wann die Filterwirkung in Abbruch umschlägt.',
      confidence: mature ? 'FACT' : 'INDICATION',
    },
    {
      ...base,
      id: fixtureUuid(`${record.spec.slug}:learning:2`),
      version: 1,
      created_at: iso(-4),
      titleDe: 'Der Einwand „kein Budget" funktioniert als Aufhänger schlechter als erwartet',
      whatWasTestedDe:
        'Das Konzept „Kein Budget für Experimente" gegen die übrigen vier freigegebenen Konzepte im selben Zeitraum.',
      creativeConceptDe: 'Kein Budget für Experimente (Einwandbehandlung).',
      funnelKind: 'MULTI_STEP_FORM',
      outcomeDe:
        'Das Konzept lag bei der CTR im Mittelfeld, erzeugte aber die niedrigste Submission-Rate aller fünf Konzepte.',
      outcomeFacts: [
        { label: 'CTR', numerator: 214, denominator: 18_402, value: 214 / 18_402, unit: 'RATE' },
        { label: 'Submission-Rate', numerator: 4, denominator: 188, value: 4 / 188, unit: 'RATE' },
      ],
      dataMaturity: 'PARTIAL',
      possibleExplanationDe:
        'Möglicherweise zieht die Einwandbehandlung genau die Betriebe an, die tatsächlich kein Budget haben — die Klickabsicht ist hoch, die Kaufabsicht nicht.',
      suggestedNextTestDe:
        'Denselben Einwand im Funnel statt in der Anzeige adressieren und die Anzeige auf das konkrete Ergebnis umstellen.',
      confidence: 'INDICATION',
    },
    {
      ...base,
      id: fixtureUuid(`${record.spec.slug}:learning:3`),
      version: 1,
      created_at: iso(-6),
      titleDe: 'No-Shows häufen sich bei Terminen mit mehr als vier Tagen Vorlauf',
      whatWasTestedDe:
        'Beobachtung über alle Arme hinweg: Zusammenhang zwischen Vorlaufzeit bis zum VQ-Termin und No-Show-Quote.',
      creativeConceptDe: null,
      funnelKind: null,
      outcomeDe:
        'Bei mehr als vier Tagen Vorlauf lag die No-Show-Quote deutlich höher. Der Zusammenhang ist nicht experimentell abgesichert.',
      outcomeFacts: [
        { label: 'No-Show bei ≤ 4 Tagen', numerator: 3, denominator: 41, value: 3 / 41, unit: 'RATE' },
        { label: 'No-Show bei > 4 Tagen', numerator: 9, denominator: 32, value: 9 / 32, unit: 'RATE' },
      ],
      dataMaturity: 'IMMATURE',
      possibleExplanationDe:
        'Der Vorlauf ist keine zugewiesene Variable, sondern hängt an der Kalenderverfügbarkeit — der Zusammenhang kann vollständig durch Selektion entstehen.',
      suggestedNextTestDe:
        'Terminslots künstlich auf maximal drei Tage Vorlauf begrenzen und die No-Show-Quote gegen den bisherigen Zeitraum vergleichen.',
      confidence: 'HYPOTHESIS',
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* The fixture port                                                            */
/* -------------------------------------------------------------------------- */

function funnelVariants(record: CampaignRecord): FunnelVariantView[] {
  const published = record.spec.granted.includes('ASSETS');
  return FUNNEL_PROPOSALS.map((proposal, index) => {
    const isForm = proposal.kind !== 'LANDING_PAGE';
    const versionId = isForm
      ? index === 0
        ? FIXTURE_IDS.formVersionId
        : fixtureUuid(`${record.spec.slug}:formversion:${proposal.key}`)
      : FIXTURE_IDS.landingPageVersionId;
    return {
      funnelId: fixtureUuid(`${record.spec.slug}:funnel:${proposal.key}`),
      versionId,
      formVersionId: isForm ? versionId : null,
      name: proposal.name,
      kind: proposal.kind,
      version: published ? 2 : 1,
      state: published ? (index === 2 ? 'DRAFT' : 'PUBLISHED') : 'DRAFT',
      promise: proposal.promise,
      hypothesis: proposal.hypothesis,
      rationale: proposal.rationale,
      qualificationQuestionCount: proposal.qualificationQuestionCount,
      publishedAt: published && index !== 2 ? iso(-record.spec.updatedDaysAgo - 2) : null,
      publicUrl:
        published && index !== 2
          ? `https://funnels.am-beratung.de/f/${record.spec.slug}-${proposal.key}`
          : null,
      builderHref: isForm ? `/builder/form/${versionId}` : `/builder/page/${versionId}`,
    };
  });
}

function headerOf(record: CampaignRecord, preview: boolean): CampaignHeaderView {
  const approvals = allApprovals(record);
  const budget: MoneyAmount = { amountMinor: record.dailyBudgetMinor, currency: 'EUR' };
  const allowed = (
    Object.keys(CAMPAIGN_TRANSITION_HELPER) as CampaignState[]
  ).filter((to) => canTransition(record.state, to) && requiredApprovalsMet(record, to));

  return {
    id: record.id,
    name: record.spec.name,
    state: record.state,
    errorState: record.spec.metaFailed ? 'META_SYNC_FAILED' : null,
    reality: realityOf(record.state, preview),
    angleName: record.spec.angleName,
    offerName: record.spec.offerName,
    audienceName: 'Geschäftsführung Handwerk, 10–99 MA, Deutschland',
    primaryMetric: primaryMetricOf(record),
    primaryMetricTarget: 22_000,
    budget,
    approvals,
    nextAction: nextActionOf(record),
    providerSync: providerSyncOf(record),
    allowedTransitions: allowed,
    updatedAt: record.updatedAt,
  };
}

/** Every state, used only as an iteration source for `canTransition`. */
const CAMPAIGN_TRANSITION_HELPER: Record<CampaignState, true> = {
  IDEA: true,
  PROPOSED: true,
  STRATEGY_REVIEW: true,
  STRATEGY_APPROVED: true,
  ASSET_GENERATION: true,
  ASSET_REVIEW: true,
  TEST_PLAN_REVIEW: true,
  READY_FOR_LAUNCH_QA: true,
  READY_FOR_META_DRAFT: true,
  META_DRAFT_CREATED: true,
  SCHEDULED: true,
  LIVE: true,
  PAUSED: true,
  COMPLETED: true,
  ARCHIVED: true,
};

export function requiredApprovalsMet(record: CampaignRecord, to: CampaignState): boolean {
  const required = REQUIRED_APPROVALS_FOR_STATE[to] ?? [];
  return required.every((kind) => approvalStatus(record, kind).valid);
}

/** Approvals that are missing or invalid for a target state, in German. */
export function missingApprovalsDe(record: CampaignRecord, to: CampaignState): ApprovalKind[] {
  const required = REQUIRED_APPROVALS_FOR_STATE[to] ?? [];
  return required.filter((kind) => !approvalStatus(record, kind).valid);
}

function rowOf(record: CampaignRecord): CampaignListRow {
  return {
    id: record.id,
    name: record.spec.name,
    state: record.state,
    errorState: record.spec.metaFailed ? 'META_SYNC_FAILED' : null,
    reality: realityOf(record.state, false),
    angleName: record.spec.angleName,
    offerName: record.spec.offerName,
    primaryMetric: primaryMetricOf(record),
    budget: { amountMinor: record.dailyBudgetMinor, currency: 'EUR' },
    nextAction: nextActionOf(record),
    providerSync: providerSyncOf(record),
    updatedAt: record.updatedAt,
  };
}

class FixtureCampaignPort implements CampaignPort {
  constructor() {
    seedStore();
  }

  private require(campaignId: string): CampaignRecord | null {
    seedStore();
    return STORE.get(campaignId) ?? null;
  }

  async listCampaigns(query: CampaignListQuery): Promise<CampaignListPage> {
    seedStore();
    const all = [...STORE.values()].map(rowOf);
    const facets = {
      angles: [...new Set(all.map((r) => r.angleName))].sort(),
      offers: [...new Set(all.map((r) => r.offerName))].sort(),
      states: [...new Set(all.map((r) => r.state))],
    };
    const filtered = filterRows(all, query);
    const start = (query.page - 1) * query.pageSize;
    return {
      rows: filtered.slice(start, start + query.pageSize),
      total: filtered.length,
      page: query.page,
      pageSize: query.pageSize,
      facets,
    };
  }

  async getHeader(campaignId: string, preview: boolean): Promise<CampaignHeaderView | null> {
    const record = this.require(campaignId);
    return record ? headerOf(record, preview) : null;
  }

  async getStrategy(campaignId: string): Promise<StrategyView | null> {
    const record = this.require(campaignId);
    if (!record) return null;
    return {
      campaignId,
      contentHash: currentHash(record, 'STRATEGY'),
      angleName: record.spec.angleName,
      anglePerspective:
        'Auslastung ist kein Vertriebsproblem, sondern ein Planbarkeitsproblem: Empfehlungen kommen, wann sie wollen — ein dokumentierter Kanal kommt, wenn er gebraucht wird.',
      angleRationale:
        'Die Zielgruppe ist mit Wachstumsversprechen gesättigt, erlebt aber Auslastungsschwankungen als konkretes Risiko. Der Angle greift das Risiko auf, nicht die Chance.',
      offer: {
        name: record.spec.offerName,
        type: 'POTENTIAL_ANALYSIS',
        valueExchange:
          'Sechs Angaben zum Betrieb gegen eine belastbare Spannbreite, wie viele qualifizierte Anfragen pro Monat realistisch planbar wären.',
        deliverable: 'Einordnung mit Spannbreite, Vergleichsgruppe und konkretem nächsten Schritt.',
        effortPromise: '2 Minuten',
        qualificationIntent:
          'Betriebsgröße, heutiger Anfrageweg, Auftragswert und Entscheidungsbefugnis werden vor dem Termin erhoben.',
      },
      audience: {
        name: 'Geschäftsführung Handwerk 10–99 MA',
        description:
          'Inhabergeführte Handwerksbetriebe in Deutschland mit 10 bis 99 Mitarbeitenden, deren Anfragen heute überwiegend über Empfehlungen entstehen.',
        audienceSegmentId: null,
        companySizeRange: '10–99 Mitarbeitende',
        industries: ['Elektro', 'Sanitär/Heizung', 'Metallbau', 'Dachdeckerei'],
        roles: ['Geschäftsführung', 'Inhaber', 'Betriebsleitung'],
        geo: 'Deutschland',
        painPoints: [
          'Auslastung schwankt unvorhersehbar zwischen Großaufträgen.',
          'Anfragen entstehen fast ausschließlich über Empfehlungen.',
          'Erstgespräche enden häufig als No-Show oder unpassend.',
        ],
        exclusions: ['Betriebe unter 5 Mitarbeitenden', 'Reine Subunternehmer ohne Endkundengeschäft'],
      },
      coreMessage: coreMessageFor(record.spec),
      hypothesis:
        'Wenn die Qualifizierung vor den Termin gezogen wird, steigt der Anteil qualifizierter VQs stärker, als die Submission-Rate fällt — die Kosten je qualifiziertem VQ sinken also trotz weniger Leads.',
      claims: CLAIMS,
      historicalEvidence: [
        {
          evidenceItemId: FIXTURE_IDS.evidenceItemId,
          kind: 'HISTORICAL_PERFORMANCE',
          summary: 'Auswertung von 42 Erstgesprächen aus 01/2026 bis 05/2026.',
          sourceRef: 'evidence/auswertung-42-erstgespraeche',
        },
        {
          evidenceItemId: FIXTURE_IDS.caseStudyId,
          kind: 'CASE_STUDY',
          summary: 'Case Study Elektro Krämer — von 3 auf 14 qualifizierte Anfragen je Quartal.',
          sourceRef: 'evidence/case-study-kraemer',
        },
      ],
      risks: [
        'Sechs Qualifizierungsfragen können die Submission-Rate stärker senken als die Terminqualität steigt.',
        'Der Angle überschneidet sich mit der Kampagne aus Q1 — ohne klare Differenzierung sind die Ergebnisse nicht vergleichbar.',
        'Die No-Show-Aussage ist eine Hypothese und darf in der Anzeige nicht als Zahl auftreten.',
      ],
      similarPastCampaigns: [
        {
          campaignId: fixtureUuid('campaign:pausiert-sanitaer'),
          campaignName: 'Sanitär Notdienst — Sommerwelle',
          similarity: 0.79,
          ranAt: '2026-05-04',
          outcomeSummary: 'CPL 18,40 €, Anteil qualifizierter VQs 24 %, Attribution auf Lead-Ebene.',
          attributionLevel: 'LEAD_LINKED',
        },
        {
          campaignId: fixtureUuid('campaign:abgeschlossen-dach'),
          campaignName: 'Dachsanierung Förderung — Q2',
          similarity: 0.64,
          ranAt: '2026-04-11',
          outcomeSummary: 'CPL 22,10 €, Anteil qualifizierter VQs 19 %, Attribution bis Umsatz.',
          attributionLevel: 'REVENUE_LINKED',
        },
      ],
      differentiationFromPast:
        'Der Q1-Angle argumentierte über Wachstum („mehr Anfragen"), dieser über Planbarkeit („verlässliche Auslastung"). Zusätzlich wird die Qualifizierung erstmals vollständig vor den Termin gezogen — die Vergleichbarkeit zur Q1-Kampagne ist deshalb auf die Leading-Indikatoren beschränkt und die CRM-Kennzahlen werden getrennt ausgewiesen.',
      approval: approvalStatus(record, 'STRATEGY'),
    };
  }

  async getCreativeBoard(campaignId: string): Promise<CreativeBoardView | null> {
    const record = this.require(campaignId);
    if (!record) return null;
    const creatives: CreativeCard[] = CONCEPTS.map((concept) => {
      const review = record.creativeReview.get(concept.key)!;
      return {
        id: fixtureUuid(`${record.spec.slug}:creative:${concept.key}`),
        key: concept.key,
        concept,
        renditions: (['1:1', '4:5'] as AspectRatio[]).map((ratio) => ({
          id: fixtureUuid(`${record.spec.slug}:${concept.key}:${ratio}`),
          aspectRatio: ratio,
          previewUrl: null,
          widthPx: ratio === '1:1' ? 1080 : 1080,
          heightPx: ratio === '1:1' ? 1080 : 1350,
          altTextDe: concept.altText,
          provenanceDe: `Motiv: fixture:gradient-noise · Template: editorial-left · Seed 20260825 · Kontrast AA geprüft`,
        })),
        reviewState: review.state,
        reviewedBy: review.by,
        reviewedAt: review.at,
        rejectedReasonDe: review.reasonDe,
      };
    });
    return {
      campaignId,
      contentHash: currentHash(record, 'ASSETS'),
      creatives,
      diversity: diversityOf(record),
      approvedCount: approvedConceptKeys(record).length,
      minApproved: GENERATION_DEFAULTS.minApprovedCreatives,
      approval: approvalStatus(record, 'ASSETS'),
    };
  }

  async getFunnelOverview(campaignId: string): Promise<FunnelOverviewView | null> {
    const record = this.require(campaignId);
    if (!record) return null;
    return {
      campaignId,
      variants: funnelVariants(record),
      minMultiStepFormVariants: GENERATION_DEFAULTS.minMultiStepFormVariants,
      mixProblemsDe: validateFunnelMix(FUNNEL_PROPOSALS),
    };
  }

  async getTestPlan(campaignId: string): Promise<TestPlanView | null> {
    const record = this.require(campaignId);
    if (!record) return null;
    return {
      campaignId,
      contentHash: currentHash(record, 'TEST_PLAN'),
      plan: {
        kind: 'BUNDLED_FUNNEL_TEST',
        hypothesis:
          'Wenn die Qualifizierung vor den Termin gezogen wird, sinken die Kosten je qualifiziertem VQ, obwohl die Submission-Rate fällt.',
        testVariable: 'Anzahl der Qualifizierungsfragen vor der Kontaktabfrage',
        controlKey: 'funnel_2',
        variantKeys: ['funnel_1', 'funnel_3'],
        primaryMetric: 'cost_per_qualified_vq',
        secondaryMetrics: ['submission_rate', 'cpl', 'qualified_vq_rate'],
        guardrailMetrics: ['ctr', 'show_rate'],
        minRuntimeDays: 14,
        maxRuntimeDays: 35,
        minSessionsPerArm: 200,
        minConversionsPerArm: 20,
        crmMaturityDays: 21,
        stopRules: [
          'Sofort stoppen, wenn ein Arm die Guardrail-Untergrenze der Submission-Rate von 2 % über drei aufeinanderfolgende Tage unterschreitet.',
          'Stoppen, wenn nach 35 Tagen kein Arm das Mindestvolumen von 200 Sessions erreicht hat.',
          'Stoppen, wenn die Eignungsfragen geändert werden — die Arme sind dann nicht mehr vergleichbar.',
        ],
        scaleRules: [
          'Erst skalieren, wenn die CRM-Ergebnisse der Kohorte reif sind (21 Tage) und die Kosten je qualifiziertem VQ unter dem Zielwert liegen.',
          'Maximal 20 % Erhöhung je Aktion, höchstens einmal in 24 Stunden.',
          'Nie skalieren, während eine Guardrail-Metrik verletzt ist.',
        ],
        eligibilityChanging: false,
      },
      budget: {
        dailyBudgetMinor: record.dailyBudgetMinor,
        currency: 'EUR',
        testBudgetMinor: record.dailyBudgetMinor * 14,
        rationale:
          'Das Tagesbudget ist so gewählt, dass jeder der drei Arme innerhalb von 14 Tagen das Mindestvolumen von 200 Sessions erreichen kann.',
        targetCplMinor: 2_200,
        targetCostPerQualifiedVqMinor: 24_000,
      },
      primaryMetric: 'cost_per_qualified_vq',
      armLabelsDe: Object.fromEntries(FUNNEL_PROPOSALS.map((f) => [f.key, f.name])),
      approval: approvalStatus(record, 'TEST_PLAN'),
    };
  }

  async getLaunchQa(campaignId: string): Promise<LaunchQaView | null> {
    const record = this.require(campaignId);
    if (!record) return null;
    const checks = launchChecks(record);
    return {
      campaignId,
      report: summarizeLaunchQa(campaignId, checks, iso(0)),
      awaitingLiveOnlyKeys: checks
        .filter((c) => c.status === 'AWAITING_EXTERNAL_INPUT' && c.blocksLiveOnly)
        .map((c) => c.key),
      metaWrites: metaWritePreviews(record),
    };
  }

  async getLivePerformance(campaignId: string): Promise<LivePerformanceView | null> {
    const record = this.require(campaignId);
    if (!record) return null;
    return {
      campaignId,
      currency: 'EUR',
      reality: realityOf(record.state, false),
      series: performanceSeries(record),
      totals: record.spec.hasPerformance ? totalsAsMetrics(record) : [],
      byCreative: breakdownRows(record, 'creative'),
      byFunnelArm: breakdownRows(record, 'funnel'),
      maturity: record.spec.state === 'COMPLETED' ? 'MATURE' : 'PARTIAL',
      attributionCoverage: record.spec.hasPerformance ? 0.83 : null,
      lastUpdatedAt: record.spec.hasPerformance ? iso(0, -2) : null,
    };
  }

  async getLeadsAndSales(campaignId: string): Promise<LeadsSalesView | null> {
    const record = this.require(campaignId);
    if (!record) return null;
    const rows = leadRows(record);
    const stages = record.spec.hasPerformance ? crmStages(record) : [];
    const won = stages.find((s) => s.key === 'closed_won')?.count ?? 0;
    return {
      campaignId,
      stages,
      revenue: { amountMinor: won * 1_450_000, currency: 'EUR' },
      revenueMaturity: record.spec.state === 'COMPLETED' ? 'MATURE' : 'IMMATURE',
      attributionCoverage: record.spec.hasPerformance ? (record.spec.state === 'COMPLETED' ? 0.91 : 0.83) : null,
      crmMaturityDays: 21,
      maturityRemainingDays: record.spec.state === 'COMPLETED' ? 0 : 9,
      leads: rows,
      failedSyncCount: rows.filter((r) => r.syncStatus === 'FAILED_RETRYING').length,
    };
  }

  async getRecommendations(campaignId: string): Promise<RecommendationView[]> {
    const record = this.require(campaignId);
    return record ? recommendationViews(record) : [];
  }

  async getLearnings(campaignId: string): Promise<LearningCard[]> {
    const record = this.require(campaignId);
    return record ? learningsOf(record) : [];
  }

  async getHistory(campaignId: string): Promise<HistoryView | null> {
    const record = this.require(campaignId);
    if (!record) return null;
    const versions: CampaignVersionEntry[] = [
      {
        versionId: fixtureUuid(`${record.spec.slug}:version:2`),
        version: 2,
        publishedAt: record.spec.granted.includes('PUBLISH') ? iso(-record.spec.updatedDaysAgo - 1) : null,
        labelDe: record.spec.granted.includes('PUBLISH') ? 'Version 2 (ausgeliefert)' : 'Version 2 (Entwurf)',
        summaryDe: 'Claim entschärft, Tagesbudget angehoben, drittes Funnel-Variantenkonzept ergänzt.',
        current: true,
        before: {
          claim: 'Eine vorgezogene Qualifizierung senkt die No-Show-Quote um 30 %.',
          dailyBudgetMinor: record.spec.dailyBudgetMinor - 2_000,
          funnelVariants: 2,
        },
        after: {
          claim: 'Eine vorgezogene Qualifizierung senkt die No-Show-Quote spürbar.',
          dailyBudgetMinor: record.dailyBudgetMinor,
          funnelVariants: 3,
        },
      },
      {
        versionId: fixtureUuid(`${record.spec.slug}:version:1`),
        version: 1,
        publishedAt: iso(-record.spec.updatedDaysAgo - 8),
        labelDe: 'Version 1',
        summaryDe: 'Erste veröffentlichte Fassung aus dem Kampagnenvorschlag.',
        current: false,
        before: null,
        after: {
          claim: 'Eine vorgezogene Qualifizierung senkt die No-Show-Quote um 30 %.',
          dailyBudgetMinor: record.spec.dailyBudgetMinor - 2_000,
          funnelVariants: 2,
        },
      },
    ];
    /*
     * The seeded chain is this campaign's history from before the process
     * started; everything `defineAction` has recorded since is the same log and
     * belongs in the same list. Reading only one of the two is how the tab ends
     * up asserting "jede Änderung" while showing a frozen set of rows.
     */
    const recorded = await readCampaignAuditLog(WORKSPACE_ID, campaignId);
    return { campaignId, versions, auditLog: mergeAuditLog(record.audit, recorded) };
  }

  /* ---- writes ---- */

  async decideApproval(input: ApprovalDecisionInput): Promise<ActionResult<ApprovalStatus>> {
    const record = this.require(input.campaignId);
    if (!record) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');

    const hash = currentHash(record, input.kind);
    if (hash !== input.contentHash) {
      return actionError(
        'CONTENT_CHANGED',
        'Der Inhalt hat sich geändert, während Sie ihn geprüft haben. Bitte laden Sie die Ansicht neu und geben Sie den aktuellen Stand frei.',
      );
    }

    const existing = record.approvals.get(input.kind)!;
    const next: Approval =
      input.decision === 'APPROVE'
        ? {
            ...existing,
            state: 'APPROVED',
            approved_content_hash: hash,
            approved_by: input.actor.id,
            approved_at: new Date().toISOString(),
            rejected_reason_de: null,
            invalidated_at: null,
            invalidated_reason_de: null,
          }
        : {
            ...existing,
            state: 'REJECTED',
            approved_content_hash: null,
            approved_by: null,
            approved_at: null,
            rejected_reason_de: input.reasonDe ?? 'Ohne Angabe eines Grundes abgelehnt.',
          };

    record.approvals.set(input.kind, next);
    record.updatedAt = new Date().toISOString();
    return actionOk(approvalStatus(record, input.kind));
  }

  async reviewCreative(input: CreativeReviewInput): Promise<ActionResult<CreativeBoardView>> {
    const record = this.require(input.campaignId);
    if (!record) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
    const entry = [...record.creativeReview.entries()].find(
      ([key]) => fixtureUuid(`${record.spec.slug}:creative:${key}`) === input.creativeId,
    );
    if (!entry) return actionError('NOT_FOUND', 'Dieses Creative gehört nicht zu dieser Kampagne.');

    const [key] = entry;
    record.creativeReview.set(key, {
      state: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      by: input.actor.displayName,
      at: new Date().toISOString(),
      reasonDe: input.decision === 'REJECT' ? (input.reasonDe ?? 'Ohne Angabe eines Grundes abgelehnt.') : null,
    });
    record.updatedAt = new Date().toISOString();
    const board = await this.getCreativeBoard(input.campaignId);
    return board ? actionOk(board) : actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
  }

  async transition(input: TransitionInput): Promise<ActionResult<CampaignHeaderView>> {
    const record = this.require(input.campaignId);
    if (!record) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');

    if (!canTransition(record.state, input.to)) {
      return actionError(
        'INVALID_TRANSITION',
        `Ein Wechsel von „${record.state}" nach „${input.to}" ist nicht vorgesehen.`,
      );
    }
    const missing = missingApprovalsDe(record, input.to);
    if (missing.length > 0) {
      return actionError(
        'APPROVAL_REQUIRED',
        `Für diesen Schritt fehlen gültige Freigaben: ${missing.join(', ')}. Eine nach der Freigabe geänderte Inhaltsfassung macht die Freigabe ungültig und erfordert eine erneute Freigabe.`,
      );
    }
    if ((input.to === 'META_DRAFT_CREATED' || input.to === 'LIVE') && diversityOf(record).blocked) {
      return actionError(
        'CREATIVE_DIVERSITY_BLOCKED',
        `Es sind weniger als ${GENERATION_DEFAULTS.minApprovedCreatives} konzeptionell unterschiedliche Creatives freigegeben.`,
      );
    }

    // The step into a state that asserts a Meta object is an external write, so
    // it takes the same route as the recommendation path: a dry run while
    // writes are off, and the state stays where it was. Recording
    // META_DRAFT_CREATED here would make the header claim a draft exists in an
    // ad account nobody has connected.
    if (isMetaWritingTransition(input.to)) {
      if (!canWriteMeta(getFeatureFlags())) {
        const preview = metaWritePreviews(record).find((write) => write.to === input.to);
        return actionDryRun(
          dryRun(
            'META',
            META_WRITING_TRANSITIONS[input.to],
            preview?.payload ?? {},
            'Meta-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / META_MUTATIONS_ENABLED = false). Es wurde nichts angelegt und der Status wurde nicht geändert.',
          ),
        );
      }
      return actionError(
        'PROVIDER_NOT_CONNECTED',
        'Externe Schreibzugriffe sind aktiviert, aber es ist kein Meta-Werbekonto verbunden. Es wurde nichts gesendet und der Status wurde nicht geändert.',
      );
    }

    record.state = input.to;
    record.updatedAt = new Date().toISOString();
    return actionOk(headerOf(record, false));
  }

  async changeBudget(input: BudgetChangeInput): Promise<ActionResult<CampaignHeaderView>> {
    const record = this.require(input.campaignId);
    if (!record) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
    if (input.newDailyBudgetMinor <= 0) {
      return actionError('VALIDATION_FAILED', 'Das Tagesbudget muss größer als null sein.', {
        fieldErrors: { newDailyBudgetMinor: 'Bitte einen Betrag größer als 0,00 € angeben.' },
      });
    }

    const current = record.dailyBudgetMinor;
    const increasePct = (input.newDailyBudgetMinor - current) / Math.max(1, current);
    const limits = input.actorRoles.map((role) => DEFAULT_ROLE_BUDGET_LIMITS[role]);
    const best = limits.reduce<{ maxSingleIncreasePct: number; maxDailyBudgetMinor: number } | null>(
      (acc, limit) =>
        acc === null || limit.maxDailyBudgetMinor > acc.maxDailyBudgetMinor ? limit : acc,
      null,
    );

    if (!best || increasePct > best.maxSingleIncreasePct || input.newDailyBudgetMinor > best.maxDailyBudgetMinor) {
      const approver = approvingRoleFor(input.newDailyBudgetMinor, increasePct);
      return actionError(
        'BUDGET_LIMIT_EXCEEDED',
        `Diese Budgetänderung überschreitet Ihr Rollenlimit und wird nicht gekürzt, sondern abgelehnt. Sie muss durch die Rolle „${approver}" freigegeben werden.`,
      );
    }

    // Once a Meta object carries the budget, changing it here changes nothing
    // over there. Reporting success and showing the new figure in the header
    // would tell the operator a live campaign spends an amount Meta has never
    // been asked to deliver at.
    if (budgetLivesAtMeta(record.state)) {
      if (!canWriteMeta(getFeatureFlags())) {
        return actionDryRun(
          dryRun(
            'META',
            'campaign.update.daily_budget',
            budgetRequestPayload(input.newDailyBudgetMinor),
          ),
        );
      }
      return actionError(
        'PROVIDER_NOT_CONNECTED',
        'Externe Schreibzugriffe sind aktiviert, aber es ist kein Meta-Werbekonto verbunden. Das Tagesbudget wurde nicht geändert.',
      );
    }

    record.dailyBudgetMinor = input.newDailyBudgetMinor;
    record.updatedAt = new Date().toISOString();
    return actionOk(headerOf(record, false));
  }

  async executeRecommendation(
    input: RecommendationExecutionInput,
  ): Promise<ActionResult<CommandOutcome>> {
    const record = this.require(input.campaignId);
    if (!record) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');

    const view = recommendationViews(record).find((v) => v.recommendation.id === input.recommendationId);
    if (!view) return actionError('NOT_FOUND', 'Diese Empfehlung gehört nicht zu dieser Kampagne.');
    if (view.recommendation.affectedMetaObjects.length === 0) {
      return actionError(
        'NO_EXTERNAL_ACTION',
        'Diese Empfehlung erfordert keine externe Aktion — sie wird durch Weiterlaufen erfüllt.',
      );
    }

    const flags = getFeatureFlags();
    if (!canWriteMeta(flags)) {
      return {
        status: 'dry_run',
        dryRun: dryRun('META', metaOperationFor(view.recommendation.action), view.requestPreview),
      };
    }

    // With writes enabled a real adapter dispatches here. The fixture refuses
    // rather than fabricating a provider confirmation.
    return actionError(
      'PROVIDER_NOT_CONNECTED',
      'Externe Schreibzugriffe sind aktiviert, aber es ist kein Meta-Werbekonto verbunden. Es wurde nichts gesendet.',
    );
  }

  async decideRecommendation(
    input: RecommendationDecisionInput,
  ): Promise<ActionResult<RecommendationView>> {
    const record = this.require(input.campaignId);
    if (!record) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');

    const find = () =>
      recommendationViews(record).find((v) => v.recommendation.id === input.recommendationId);

    const view = find();
    if (!view) return actionError('NOT_FOUND', 'Diese Empfehlung gehört nicht zu dieser Kampagne.');
    if (view.recommendation.state !== 'OPEN') {
      return actionError(
        'ALREADY_DECIDED',
        'Über diese Empfehlung wurde bereits entschieden. Eine erneute Entscheidung ändert nichts.',
      );
    }
    // Accepting a recommendation that does touch Meta would leave the operator
    // believing the change is on its way. Those are accepted by executing them.
    if (input.decision === 'ACCEPT' && view.recommendation.affectedMetaObjects.length > 0) {
      return actionError(
        'EXTERNAL_ACTION_REQUIRED',
        'Diese Empfehlung verändert Objekte bei Meta. Sie wird über „Annehmen und ausführen" umgesetzt, nicht durch bloßes Annehmen.',
      );
    }

    record.recommendationDecisions.set(input.recommendationId, {
      state: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DISMISSED',
      reasonDe: input.reasonDe?.trim() ? input.reasonDe.trim() : null,
    });
    record.updatedAt = new Date().toISOString();

    const decided = find();
    return decided
      ? actionOk(decided)
      : actionError('NOT_FOUND', 'Diese Empfehlung gehört nicht zu dieser Kampagne.');
  }

  async retryLeadSync(input: LeadSyncRetryInput): Promise<ActionResult<LeadRow>> {
    const record = this.require(input.campaignId);
    if (!record) return actionError('NOT_FOUND', 'Diese Kampagne existiert nicht.');
    const sync = record.leadSync.get(input.leadId);
    if (!sync) return actionError('NOT_FOUND', 'Dieser Lead gehört nicht zu dieser Kampagne.');
    if (sync.status !== 'FAILED_RETRYING') {
      return actionError('NOT_RETRYABLE', 'Für diesen Lead steht keine Wiederholung an.');
    }

    const flags = getFeatureFlags();
    if (!flags.externalWritesEnabled || !flags.hubspotWritesEnabled) {
      record.leadSync.set(input.leadId, { ...sync, attempts: sync.attempts + 1 });
      return {
        status: 'dry_run',
        dryRun: dryRun('HUBSPOT', 'contacts.upsert', { lead_id: input.leadId, retry: true }),
      };
    }
    return actionError(
      'PROVIDER_NOT_CONNECTED',
      'HubSpot ist nicht verbunden. Es wurde nichts gesendet.',
    );
  }
}

function metaOperationFor(action: string): string {
  switch (action) {
    case 'PAUSE_CREATIVE':
      return 'ad.update.status';
    case 'PAUSE_FUNNEL_ARM':
      return 'adset.update.status';
    case 'INCREASE_BUDGET':
    case 'DECREASE_BUDGET':
      return 'campaign.update.daily_budget';
    default:
      return 'campaign.update';
  }
}

/** Names the least-privileged role that could approve a given change. */
function approvingRoleFor(newDailyBudgetMinor: number, increasePct: number): string {
  const candidates: Role[] = rolesWithPermission('campaign.scale_budget_major');
  const fit = candidates.find((role) => {
    const limit = DEFAULT_ROLE_BUDGET_LIMITS[role];
    return increasePct <= limit.maxSingleIncreasePct && newDailyBudgetMinor <= limit.maxDailyBudgetMinor;
  });
  return ROLE_LABELS_DE[fit ?? 'EXECUTIVE'];
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                   */
/* -------------------------------------------------------------------------- */

/** Pure so the list page and its tests share one definition of "filtered". */
export function filterRows(rows: CampaignListRow[], query: CampaignListQuery): CampaignListRow[] {
  const search = query.search?.trim().toLowerCase() ?? '';
  return rows
    .filter((row) => (query.states.length === 0 ? true : query.states.includes(row.state)))
    .filter((row) => (query.angles.length === 0 ? true : query.angles.includes(row.angleName)))
    .filter((row) => (query.offers.length === 0 ? true : query.offers.includes(row.offerName)))
    .filter((row) => (query.from === null ? true : row.updatedAt.slice(0, 10) >= query.from))
    .filter((row) => (query.to === null ? true : row.updatedAt.slice(0, 10) <= query.to))
    .filter((row) => (search === '' ? true : row.name.toLowerCase().includes(search)))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

let port: CampaignPort | null = null;

/**
 * The single place fixture vs. repository is decided.
 *
 * `resolveDatabase()` already owns that decision for the whole product — demo
 * mode first, then whether a Supabase project is configured at all — and reports
 * which store it chose. Re-deriving it from `DEMO_MODE` here would be a second
 * answer to a question that already has one, and the two would eventually
 * disagree. `mode: 'memory'` means nothing is persisted, which is precisely the
 * situation the fixture exists for; `mode: 'supabase'` means the repositories
 * can answer, and the Campaign Room reads and writes real rows.
 *
 * The client is rebuilt per call rather than captured once, because a Supabase
 * server client carries the requesting operator's session: one shared instance
 * would hand every later request whichever operator happened to construct it,
 * and RLS would then be evaluated for the wrong person.
 */
export function getCampaignPort(): CampaignPort {
  if (port) return port;

  const { mode } = resolveDatabase({ demo: getFeatureFlags().demoMode });
  logger.info('campaign_port_ready', { store: mode });

  if (mode === 'memory') {
    port = new FixtureCampaignPort();
    return port;
  }

  port = createDatabaseCampaignPort({
    database: campaignDatabase,
    workspaceId: WORKSPACE_ID,
    // Without a DATABASE_URL the multi-row writes have no way to be atomic, and
    // the port refuses them rather than performing half of one.
    transaction: createPgTransactionRunner(),
  });
  return port;
}

/**
 * Repositories for one call, bound to the requesting operator's cookies so RLS
 * and the capability policies in `0018_role_gated_writes.sql` are evaluated for
 * the operator who pressed the button.
 *
 * `next/headers` is imported dynamically: this module is also loaded by the
 * component tests, which have no request scope, and a static import would pull
 * the request context into every one of them.
 */
async function campaignDatabase(): Promise<AmDatabase> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  return resolveDatabase({
    demo: getFeatureFlags().demoMode,
    cookies: { getAll: () => store.getAll() },
  }).db;
}

/** Test seam: replaces the port for the duration of a test. */
export function setCampaignPort(next: CampaignPort | null): void {
  port = next;
}

export { CONCEPTS as FIXTURE_CREATIVE_CONCEPTS, CREATIVE_PRINCIPLES, METRIC_CATALOG };
export type { CampaignRecord };
