import { type ComponentType } from 'react';
import {
  CAMPAIGN_ERROR_LABELS_DE,
  CAMPAIGN_STATE_LABELS_DE,
  COMMAND_STATE_LABELS_DE,
  CONNECTION_STATE_LABELS_DE,
  EXPERIMENT_VERDICT_LABELS_DE,
  HEALTH_STATUS_LABELS_DE,
  OUTBOX_STATE_LABELS_DE,
  type ApprovalState,
  type AssetReviewState,
  type CampaignErrorState,
  type CampaignState,
  type CommandState,
  type ConnectionState,
  type ExperimentState,
  type ExperimentVerdict,
  type FunnelVersionState,
  type HealthStatus,
  type OutboxState,
  type RecommendationState,
  type SubmissionState,
  type SyncStatus,
} from '@am/domain';
import {
  Archive,
  Ban,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Database,
  Eye,
  FileCheck,
  FileText,
  FlaskConical,
  Hourglass,
  Image as ImageIcon,
  Inbox,
  Lightbulb,
  ListChecks,
  Loader2,
  OctagonAlert,
  Pause,
  Play,
  Plug,
  PlugZap,
  Radio,
  RefreshCcw,
  Rocket,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  TriangleAlert,
  Trophy,
  XCircle,
} from 'lucide-react';
import { type BadgeTone } from '../components/badge';

export type StatusIcon = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true';
}>;

export interface StatusDescriptor {
  /** German label rendered inside the badge. */
  label: string;
  tone: BadgeTone;
  icon: StatusIcon;
}

/* -------------------------------------------------------------------------- */
/* German labels the domain package does not ship                              */
/* -------------------------------------------------------------------------- */

export const APPROVAL_STATE_LABELS_DE: Readonly<Record<ApprovalState, string>> = {
  PENDING: 'Freigabe ausstehend',
  APPROVED: 'Freigegeben',
  REJECTED: 'Abgelehnt',
  INVALIDATED: 'Durch Änderung ungültig',
};

export const SYNC_STATUS_LABELS_DE: Readonly<Record<SyncStatus, string>> = {
  PENDING: 'Sync ausstehend',
  SYNCED: 'Synchronisiert',
  FAILED_RETRYING: 'Sync fehlgeschlagen – Wiederholung',
  DEAD_LETTER: 'Dead Letter',
};

export const SUBMISSION_STATE_LABELS_DE: Readonly<Record<SubmissionState, string>> = {
  CREATED: 'Erstellt',
  VALIDATED: 'Validiert',
  ACCEPTED: 'Angenommen',
  HUBSPOT_PENDING: 'HubSpot-Übertragung ausstehend',
  HUBSPOT_SYNCED: 'An HubSpot übertragen',
  REJECTED_VALIDATION: 'Validierung fehlgeschlagen',
  REJECTED_SPAM: 'Als Spam abgewiesen',
  SYNC_FAILED_RETRYING: 'Sync fehlgeschlagen – Wiederholung',
  DEAD_LETTER: 'Dead Letter',
};

export const EXPERIMENT_STATE_LABELS_DE: Readonly<Record<ExperimentState, string>> = {
  DRAFT: 'Entwurf',
  READY: 'Startbereit',
  RUNNING: 'Läuft',
  PAUSED: 'Pausiert',
  CONCLUDED: 'Beendet',
  ABANDONED: 'Abgebrochen',
};

export const RECOMMENDATION_STATE_LABELS_DE: Readonly<Record<RecommendationState, string>> = {
  OPEN: 'Offen',
  ACCEPTED: 'Angenommen',
  DISMISSED: 'Verworfen',
  EXECUTING: 'Wird ausgeführt',
  EXECUTED: 'Ausgeführt',
  EXECUTION_FAILED: 'Ausführung fehlgeschlagen',
  SUPERSEDED: 'Ersetzt',
};

export const ASSET_REVIEW_STATE_LABELS_DE: Readonly<Record<AssetReviewState, string>> = {
  DRAFT: 'Entwurf',
  IN_REVIEW: 'In Prüfung',
  APPROVED: 'Freigegeben',
  REJECTED: 'Abgelehnt',
};

export const FUNNEL_VERSION_STATE_LABELS_DE: Readonly<Record<FunnelVersionState, string>> = {
  DRAFT: 'Entwurf',
  PUBLISHED: 'Veröffentlicht',
  ARCHIVED: 'Archiviert',
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

const campaign: Record<CampaignState, StatusDescriptor> = {
  IDEA: { label: CAMPAIGN_STATE_LABELS_DE.IDEA, tone: 'neutral', icon: Lightbulb },
  PROPOSED: { label: CAMPAIGN_STATE_LABELS_DE.PROPOSED, tone: 'neutral', icon: FileText },
  STRATEGY_REVIEW: {
    label: CAMPAIGN_STATE_LABELS_DE.STRATEGY_REVIEW,
    tone: 'info',
    icon: ClipboardList,
  },
  STRATEGY_APPROVED: {
    label: CAMPAIGN_STATE_LABELS_DE.STRATEGY_APPROVED,
    tone: 'success',
    icon: ClipboardCheck,
  },
  ASSET_GENERATION: {
    label: CAMPAIGN_STATE_LABELS_DE.ASSET_GENERATION,
    tone: 'info',
    icon: Sparkles,
  },
  ASSET_REVIEW: { label: CAMPAIGN_STATE_LABELS_DE.ASSET_REVIEW, tone: 'info', icon: ImageIcon },
  TEST_PLAN_REVIEW: {
    label: CAMPAIGN_STATE_LABELS_DE.TEST_PLAN_REVIEW,
    tone: 'info',
    icon: FlaskConical,
  },
  READY_FOR_LAUNCH_QA: {
    label: CAMPAIGN_STATE_LABELS_DE.READY_FOR_LAUNCH_QA,
    tone: 'info',
    icon: ListChecks,
  },
  READY_FOR_META_DRAFT: {
    label: CAMPAIGN_STATE_LABELS_DE.READY_FOR_META_DRAFT,
    tone: 'info',
    icon: FileCheck,
  },
  META_DRAFT_CREATED: {
    label: CAMPAIGN_STATE_LABELS_DE.META_DRAFT_CREATED,
    tone: 'warning',
    icon: Pause,
  },
  SCHEDULED: { label: CAMPAIGN_STATE_LABELS_DE.SCHEDULED, tone: 'info', icon: CalendarClock },
  LIVE: { label: CAMPAIGN_STATE_LABELS_DE.LIVE, tone: 'success', icon: Radio },
  PAUSED: { label: CAMPAIGN_STATE_LABELS_DE.PAUSED, tone: 'warning', icon: Pause },
  COMPLETED: { label: CAMPAIGN_STATE_LABELS_DE.COMPLETED, tone: 'neutral', icon: CheckCircle2 },
  ARCHIVED: { label: CAMPAIGN_STATE_LABELS_DE.ARCHIVED, tone: 'neutral', icon: Archive },
};

const campaignError: Record<CampaignErrorState, StatusDescriptor> = {
  GENERATION_FAILED: {
    label: CAMPAIGN_ERROR_LABELS_DE.GENERATION_FAILED,
    tone: 'destructive',
    icon: OctagonAlert,
  },
  PUBLISH_FAILED: {
    label: CAMPAIGN_ERROR_LABELS_DE.PUBLISH_FAILED,
    tone: 'destructive',
    icon: OctagonAlert,
  },
  META_SYNC_FAILED: {
    label: CAMPAIGN_ERROR_LABELS_DE.META_SYNC_FAILED,
    tone: 'destructive',
    icon: OctagonAlert,
  },
  TRACKING_FAILED: {
    label: CAMPAIGN_ERROR_LABELS_DE.TRACKING_FAILED,
    tone: 'destructive',
    icon: OctagonAlert,
  },
  HUBSPOT_SYNC_FAILED: {
    label: CAMPAIGN_ERROR_LABELS_DE.HUBSPOT_SYNC_FAILED,
    tone: 'destructive',
    icon: OctagonAlert,
  },
};

const approval: Record<ApprovalState, StatusDescriptor> = {
  PENDING: { label: APPROVAL_STATE_LABELS_DE.PENDING, tone: 'warning', icon: Hourglass },
  APPROVED: { label: APPROVAL_STATE_LABELS_DE.APPROVED, tone: 'success', icon: ShieldCheck },
  REJECTED: { label: APPROVAL_STATE_LABELS_DE.REJECTED, tone: 'destructive', icon: XCircle },
  INVALIDATED: {
    label: APPROVAL_STATE_LABELS_DE.INVALIDATED,
    tone: 'warning',
    icon: TriangleAlert,
  },
};

const sync: Record<SyncStatus, StatusDescriptor> = {
  PENDING: { label: SYNC_STATUS_LABELS_DE.PENDING, tone: 'neutral', icon: Clock },
  SYNCED: { label: SYNC_STATUS_LABELS_DE.SYNCED, tone: 'success', icon: CheckCircle2 },
  FAILED_RETRYING: {
    label: SYNC_STATUS_LABELS_DE.FAILED_RETRYING,
    tone: 'warning',
    icon: RefreshCcw,
  },
  DEAD_LETTER: { label: SYNC_STATUS_LABELS_DE.DEAD_LETTER, tone: 'destructive', icon: Trash2 },
};

const outbox: Record<OutboxState, StatusDescriptor> = {
  PENDING: { label: OUTBOX_STATE_LABELS_DE.PENDING, tone: 'neutral', icon: Clock },
  PROCESSING: { label: OUTBOX_STATE_LABELS_DE.PROCESSING, tone: 'info', icon: Loader2 },
  SENT: { label: OUTBOX_STATE_LABELS_DE.SENT, tone: 'info', icon: Send },
  ACCEPTED: { label: OUTBOX_STATE_LABELS_DE.ACCEPTED, tone: 'success', icon: CheckCircle2 },
  FAILED_RETRYING: {
    label: OUTBOX_STATE_LABELS_DE.FAILED_RETRYING,
    tone: 'warning',
    icon: RefreshCcw,
  },
  DEAD_LETTER: { label: OUTBOX_STATE_LABELS_DE.DEAD_LETTER, tone: 'destructive', icon: Trash2 },
  EXPIRED: { label: OUTBOX_STATE_LABELS_DE.EXPIRED, tone: 'neutral', icon: Ban },
};

const command: Record<CommandState, StatusDescriptor> = {
  PENDING_CONFIRMATION: {
    label: COMMAND_STATE_LABELS_DE.PENDING_CONFIRMATION,
    tone: 'warning',
    icon: ShieldAlert,
  },
  QUEUED: { label: COMMAND_STATE_LABELS_DE.QUEUED, tone: 'neutral', icon: Clock },
  IN_FLIGHT: { label: COMMAND_STATE_LABELS_DE.IN_FLIGHT, tone: 'info', icon: Loader2 },
  PROVIDER_CONFIRMED: {
    label: COMMAND_STATE_LABELS_DE.PROVIDER_CONFIRMED,
    tone: 'success',
    icon: CheckCircle2,
  },
  FAILED: { label: COMMAND_STATE_LABELS_DE.FAILED, tone: 'destructive', icon: OctagonAlert },
  RECONCILED: { label: COMMAND_STATE_LABELS_DE.RECONCILED, tone: 'success', icon: RefreshCcw },
  BLOCKED_BY_FLAG: {
    label: COMMAND_STATE_LABELS_DE.BLOCKED_BY_FLAG,
    tone: 'warning',
    icon: ShieldAlert,
  },
};

const submission: Record<SubmissionState, StatusDescriptor> = {
  CREATED: { label: SUBMISSION_STATE_LABELS_DE.CREATED, tone: 'neutral', icon: Inbox },
  VALIDATED: { label: SUBMISSION_STATE_LABELS_DE.VALIDATED, tone: 'info', icon: ClipboardCheck },
  ACCEPTED: { label: SUBMISSION_STATE_LABELS_DE.ACCEPTED, tone: 'info', icon: CheckCircle2 },
  HUBSPOT_PENDING: {
    label: SUBMISSION_STATE_LABELS_DE.HUBSPOT_PENDING,
    tone: 'neutral',
    icon: Clock,
  },
  HUBSPOT_SYNCED: {
    label: SUBMISSION_STATE_LABELS_DE.HUBSPOT_SYNCED,
    tone: 'success',
    icon: Database,
  },
  REJECTED_VALIDATION: {
    label: SUBMISSION_STATE_LABELS_DE.REJECTED_VALIDATION,
    tone: 'destructive',
    icon: XCircle,
  },
  REJECTED_SPAM: {
    label: SUBMISSION_STATE_LABELS_DE.REJECTED_SPAM,
    tone: 'destructive',
    icon: Ban,
  },
  SYNC_FAILED_RETRYING: {
    label: SUBMISSION_STATE_LABELS_DE.SYNC_FAILED_RETRYING,
    tone: 'warning',
    icon: RefreshCcw,
  },
  DEAD_LETTER: {
    label: SUBMISSION_STATE_LABELS_DE.DEAD_LETTER,
    tone: 'destructive',
    icon: Trash2,
  },
};

const experiment: Record<ExperimentState, StatusDescriptor> = {
  DRAFT: { label: EXPERIMENT_STATE_LABELS_DE.DRAFT, tone: 'neutral', icon: FileText },
  READY: { label: EXPERIMENT_STATE_LABELS_DE.READY, tone: 'info', icon: Rocket },
  RUNNING: { label: EXPERIMENT_STATE_LABELS_DE.RUNNING, tone: 'success', icon: Play },
  PAUSED: { label: EXPERIMENT_STATE_LABELS_DE.PAUSED, tone: 'warning', icon: Pause },
  CONCLUDED: { label: EXPERIMENT_STATE_LABELS_DE.CONCLUDED, tone: 'neutral', icon: CheckCircle2 },
  ABANDONED: { label: EXPERIMENT_STATE_LABELS_DE.ABANDONED, tone: 'neutral', icon: Ban },
};

const verdict: Record<ExperimentVerdict, StatusDescriptor> = {
  WINNER: { label: EXPERIMENT_VERDICT_LABELS_DE.WINNER, tone: 'success', icon: Trophy },
  PROVISIONAL: { label: EXPERIMENT_VERDICT_LABELS_DE.PROVISIONAL, tone: 'info', icon: Target },
  NO_DIFFERENCE: {
    label: EXPERIMENT_VERDICT_LABELS_DE.NO_DIFFERENCE,
    tone: 'neutral',
    icon: Eye,
  },
  INCONCLUSIVE: {
    label: EXPERIMENT_VERDICT_LABELS_DE.INCONCLUSIVE,
    tone: 'warning',
    icon: TriangleAlert,
  },
  INSUFFICIENT_DATA: {
    label: EXPERIMENT_VERDICT_LABELS_DE.INSUFFICIENT_DATA,
    tone: 'warning',
    icon: Hourglass,
  },
};

const recommendation: Record<RecommendationState, StatusDescriptor> = {
  OPEN: { label: RECOMMENDATION_STATE_LABELS_DE.OPEN, tone: 'info', icon: Lightbulb },
  ACCEPTED: {
    label: RECOMMENDATION_STATE_LABELS_DE.ACCEPTED,
    tone: 'info',
    icon: ClipboardCheck,
  },
  DISMISSED: { label: RECOMMENDATION_STATE_LABELS_DE.DISMISSED, tone: 'neutral', icon: Ban },
  EXECUTING: { label: RECOMMENDATION_STATE_LABELS_DE.EXECUTING, tone: 'info', icon: Loader2 },
  EXECUTED: {
    label: RECOMMENDATION_STATE_LABELS_DE.EXECUTED,
    tone: 'success',
    icon: CheckCircle2,
  },
  EXECUTION_FAILED: {
    label: RECOMMENDATION_STATE_LABELS_DE.EXECUTION_FAILED,
    tone: 'destructive',
    icon: OctagonAlert,
  },
  SUPERSEDED: {
    label: RECOMMENDATION_STATE_LABELS_DE.SUPERSEDED,
    tone: 'neutral',
    icon: RefreshCcw,
  },
};

const connection: Record<ConnectionState, StatusDescriptor> = {
  NOT_CONFIGURED: {
    label: CONNECTION_STATE_LABELS_DE.NOT_CONFIGURED,
    tone: 'neutral',
    icon: Plug,
  },
  FIXTURE: { label: CONNECTION_STATE_LABELS_DE.FIXTURE, tone: 'info', icon: FlaskConical },
  CONNECTED: { label: CONNECTION_STATE_LABELS_DE.CONNECTED, tone: 'success', icon: PlugZap },
  DEGRADED: { label: CONNECTION_STATE_LABELS_DE.DEGRADED, tone: 'warning', icon: TriangleAlert },
  ERROR: { label: CONNECTION_STATE_LABELS_DE.ERROR, tone: 'destructive', icon: OctagonAlert },
};

const health: Record<HealthStatus, StatusDescriptor> = {
  PASS: { label: HEALTH_STATUS_LABELS_DE.PASS, tone: 'success', icon: CheckCircle2 },
  WARN: { label: HEALTH_STATUS_LABELS_DE.WARN, tone: 'warning', icon: TriangleAlert },
  FAIL: { label: HEALTH_STATUS_LABELS_DE.FAIL, tone: 'destructive', icon: OctagonAlert },
  AWAITING_EXTERNAL_INPUT: {
    label: HEALTH_STATUS_LABELS_DE.AWAITING_EXTERNAL_INPUT,
    tone: 'info',
    icon: Hourglass,
  },
};

const assetReview: Record<AssetReviewState, StatusDescriptor> = {
  DRAFT: { label: ASSET_REVIEW_STATE_LABELS_DE.DRAFT, tone: 'neutral', icon: FileText },
  IN_REVIEW: { label: ASSET_REVIEW_STATE_LABELS_DE.IN_REVIEW, tone: 'info', icon: Eye },
  APPROVED: { label: ASSET_REVIEW_STATE_LABELS_DE.APPROVED, tone: 'success', icon: ShieldCheck },
  REJECTED: { label: ASSET_REVIEW_STATE_LABELS_DE.REJECTED, tone: 'destructive', icon: XCircle },
};

const funnelVersion: Record<FunnelVersionState, StatusDescriptor> = {
  DRAFT: { label: FUNNEL_VERSION_STATE_LABELS_DE.DRAFT, tone: 'neutral', icon: FileText },
  PUBLISHED: {
    label: FUNNEL_VERSION_STATE_LABELS_DE.PUBLISHED,
    tone: 'success',
    icon: CheckCircle2,
  },
  ARCHIVED: { label: FUNNEL_VERSION_STATE_LABELS_DE.ARCHIVED, tone: 'neutral', icon: Archive },
};

/**
 * Every state the console can render as a badge, with its German label, tone
 * and icon. Tone is decoration; the label and the icon carry the meaning.
 */
export const STATUS_REGISTRY = {
  campaign,
  campaignError,
  approval,
  sync,
  outbox,
  command,
  submission,
  experiment,
  verdict,
  recommendation,
  connection,
  health,
  assetReview,
  funnelVersion,
} as const;

export type StatusKind = keyof typeof STATUS_REGISTRY;

/** The union of `{ kind, state }` pairs the registry accepts. */
export type StatusSelector = {
  [K in StatusKind]: { kind: K; state: keyof (typeof STATUS_REGISTRY)[K] };
}[StatusKind];

export function resolveStatus(selector: StatusSelector): StatusDescriptor {
  const group = STATUS_REGISTRY[selector.kind] as Record<string, StatusDescriptor>;
  const descriptor = group[selector.state as string];
  if (descriptor) return descriptor;
  // Unknown states must still render something readable rather than crash.
  return { label: String(selector.state), tone: 'neutral', icon: Clock };
}
