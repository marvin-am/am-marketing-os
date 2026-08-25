import type {
  AttributionLevel,
  ConfidenceLabel,
  ConnectionState,
  CreativePrinciple,
  FunnelKind,
  VqStatus,
} from '@am/domain';
import type { CampaignReality, ProviderSyncStatus } from '@/server/campaign-port';

/**
 * German vocabulary that belongs to the Campaign Room specifically. Anything
 * shared across the product lives in `@am/domain` or `@am/ui` instead.
 */

export interface RealityDescriptor {
  labelDe: string;
  /** One sentence saying exactly what the operator is looking at. */
  explanationDe: string;
  /** Tone token used for the banner and the header rail. */
  tone: 'preview' | 'draft' | 'paused-draft' | 'live' | 'paused' | 'ended';
}

/**
 * The three realities whose wording is a statement about *Meta's* records
 * rather than ours.
 *
 * `PREVIEW`, `DRAFT` and `ENDED` describe our own documents and are true
 * whatever the provider does. The other three assert that an object exists in
 * an ad account, is delivering, or was paused there — none of which the console
 * can know from its own state machine. Saying them requires a command in
 * `PROVIDER_CONFIRMED` / `RECONCILED` behind a real connection; without one the
 * console says what it requested, never what exists over there.
 */
export const PROVIDER_ASSERTING_REALITIES: readonly CampaignReality[] = [
  'META_DRAFT_PAUSED',
  'LIVE',
  'PAUSED',
];

export function assertsProviderFact(reality: CampaignReality): boolean {
  return PROVIDER_ASSERTING_REALITIES.includes(reality);
}

/**
 * Preview, an internal draft, the paused Meta draft and a delivering campaign
 * must never be confusable. Each carries its own word, its own sentence and its
 * own visual treatment — colour is never the only difference.
 *
 * These are the descriptors that hold **without** a provider confirmation, so
 * anything rendering a reality without knowing the provider's answer is honest
 * by default. `REALITY_PROVIDER_CONFIRMED` carries the stronger wording, and
 * `realityDescriptor` is the only way to reach it.
 */
export const REALITY: Readonly<Record<CampaignReality, RealityDescriptor>> = {
  PREVIEW: {
    labelDe: 'Vorschau',
    explanationDe:
      'Vorschau eines nicht veröffentlichten Stands. Nichts davon ist ausgeliefert und keine Aktion auf dieser Seite verändert etwas bei Meta.',
    tone: 'preview',
  },
  DRAFT: {
    labelDe: 'Entwurf',
    explanationDe:
      'Interner Entwurf. Es existiert kein Meta-Objekt zu dieser Kampagne und es wird nichts ausgeliefert.',
    tone: 'draft',
  },
  META_DRAFT_PAUSED: {
    labelDe: 'Meta-Entwurf – von Meta nicht bestätigt',
    explanationDe:
      'Der pausierte Entwurf ist angefordert, aber von Meta nicht bestätigt. Ob dort ein Objekt existiert, ist damit offen; er liefert nichts aus und verbraucht kein Budget.',
    tone: 'paused-draft',
  },
  LIVE: {
    labelDe: 'Live – von Meta nicht bestätigt',
    explanationDe:
      'Diese Kampagne ist bei uns als live geführt. Meta hat die Auslieferung nicht bestätigt, deshalb sagt diese Ansicht nicht, dass dort ausgeliefert wird.',
    tone: 'live',
  },
  PAUSED: {
    labelDe: 'Pausiert – von Meta nicht bestätigt',
    explanationDe:
      'Die Kampagne ist bei uns als pausiert geführt. Meta hat die Pausierung nicht bestätigt; die bisherigen Ergebnisse bleiben erhalten.',
    tone: 'paused',
  },
  ENDED: {
    labelDe: 'Abgeschlossen',
    explanationDe:
      'Die Kampagne ist beendet. Die Zahlen sind final, es wird nichts mehr ausgeliefert.',
    tone: 'ended',
  },
};

/**
 * The wording that may only be shown once the provider has actually confirmed.
 * Reachable exclusively through `realityDescriptor`, so it cannot be rendered
 * by accident.
 */
export const REALITY_PROVIDER_CONFIRMED: Readonly<
  Partial<Record<CampaignReality, RealityDescriptor>>
> = {
  META_DRAFT_PAUSED: {
    labelDe: 'Meta-Entwurf – pausiert',
    explanationDe:
      'Bei Meta existiert ein Entwurf im Status PAUSED. Er liefert nichts aus, verbraucht kein Budget und wird erst durch die Live-Schaltung aktiv.',
    tone: 'paused-draft',
  },
  LIVE: {
    labelDe: 'Live – liefert aus',
    explanationDe:
      'Diese Kampagne liefert bei Meta aus und verbraucht Budget. Änderungen wirken sich auf laufende Auslieferung aus.',
    tone: 'live',
  },
  PAUSED: {
    labelDe: 'Pausiert',
    explanationDe:
      'Die Kampagne war live und ist pausiert. Es wird nichts ausgeliefert; die bisherigen Ergebnisse bleiben erhalten.',
    tone: 'paused',
  },
};

/**
 * The descriptor to render. `providerConfirmed` must come from the provider —
 * never from the campaign's own state, which is exactly the thing in question.
 */
export function realityDescriptor(
  reality: CampaignReality,
  providerConfirmed: boolean,
): RealityDescriptor {
  if (!providerConfirmed) return REALITY[reality];
  return REALITY_PROVIDER_CONFIRMED[reality] ?? REALITY[reality];
}

/** The only connection state in which Meta can attest to anything. */
const CONFIRMING_CONNECTION: ConnectionState = 'CONNECTED';

/**
 * Whether this campaign's Meta-side claims may be stated as facts.
 *
 * `FIXTURE` and `NOT_CONFIGURED` are explicitly not a connection, and a failing
 * or degraded one has just told us its picture of the ad account is unreliable.
 * This is what keeps the header from claiming a draft exists while the
 * provider-sync panel beside it reports that no access token is configured.
 */
export function metaFactsConfirmed(providerSync: readonly ProviderSyncStatus[]): boolean {
  const meta = providerSync.find((sync) => sync.provider === 'META');
  return meta?.connection === CONFIRMING_CONNECTION && meta.health === 'PASS';
}

/** Border + background treatment per reality. Read together with the label. */
export const REALITY_SURFACE: Readonly<Record<CampaignReality, string>> = {
  PREVIEW: 'border-info-border bg-info-surface',
  DRAFT: 'border-border-strong bg-surface-sunken',
  META_DRAFT_PAUSED: 'border-warning-border bg-warning-surface',
  LIVE: 'border-success-border bg-success-surface',
  PAUSED: 'border-warning-border bg-warning-surface',
  ENDED: 'border-border bg-surface-raised',
};

export const REALITY_ACCENT: Readonly<Record<CampaignReality, string>> = {
  PREVIEW: 'text-info',
  DRAFT: 'text-muted-foreground',
  META_DRAFT_PAUSED: 'text-warning',
  LIVE: 'text-success',
  PAUSED: 'text-warning',
  ENDED: 'text-muted-foreground',
};

export const FUNNEL_KIND_LABELS_DE: Readonly<Record<FunnelKind, string>> = {
  LANDING_PAGE: 'Landingpage',
  MULTI_STEP_FORM: 'Mehrstufiges Formular',
  HYBRID: 'Hybrid (Seite + Formular)',
};

export const VQ_STATUS_LABELS_DE: Readonly<Record<VqStatus, string>> = {
  NOT_SCHEDULED: 'Nicht terminiert',
  SCHEDULED: 'Terminiert',
  ATTENDED: 'Stattgefunden',
  NO_SHOW: 'Nicht erschienen',
  PASSED: 'Qualifiziert',
  REJECTED: 'Abgelehnt',
};

export const ATTRIBUTION_LEVEL_LABELS_DE: Readonly<Record<AttributionLevel, string>> = {
  CREATIVE_ONLY: 'Nur Creative',
  TRAFFIC_LINKED: 'Bis Traffic',
  LEAD_LINKED: 'Bis Lead',
  REVENUE_LINKED: 'Bis Umsatz',
};

export const CONFIDENCE_ORDER: readonly ConfidenceLabel[] = ['FACT', 'INDICATION', 'HYPOTHESIS'];

/** German label for a claim that carries no evidence. */
export const HYPOTHESIS_NOTICE_DE =
  'Ohne Beleg — darf ausschließlich als Hypothese kommuniziert werden, nie als Zahl oder Tatsache.';

/** The six mandated communication principles, in operator language. */
export const PRINCIPLE_LABELS_DE: Readonly<Record<CreativePrinciple, string>> = {
  PROBLEM_PAIN: 'Problem und Schmerz',
  CONCRETE_RESULT: 'Konkretes Ergebnis',
  COMPARISON_ALTERNATIVE: 'Vergleich zur Alternative',
  PROOF_CASE_DATAPOINT: 'Beleg, Case oder Datenpunkt',
  OBJECTION_HANDLING: 'Einwandbehandlung',
  CONTRARIAN_INSIGHT: 'Konträre Einsicht',
};
