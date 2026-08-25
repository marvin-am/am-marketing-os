import type {
  AttributionLevel,
  ConfidenceLabel,
  CreativePrinciple,
  FunnelKind,
  VqStatus,
} from '@am/domain';
import type { CampaignReality } from '@/server/campaign-port';

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
 * Preview, an internal draft, the paused Meta draft and a delivering campaign
 * must never be confusable. Each carries its own word, its own sentence and its
 * own visual treatment — colour is never the only difference.
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
  ENDED: {
    labelDe: 'Abgeschlossen',
    explanationDe:
      'Die Kampagne ist beendet. Die Zahlen sind final, es wird nichts mehr ausgeliefert.',
    tone: 'ended',
  },
};

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
