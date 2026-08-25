/**
 * External command execution.
 *
 * Every mutation Meta ever sees goes through an `ExternalCommand` record and
 * this state machine:
 *
 *   PENDING_CONFIRMATION → QUEUED → IN_FLIGHT → PROVIDER_CONFIRMED → RECONCILED
 *                                            ↘ FAILED
 *                        ↘ BLOCKED_BY_FLAG
 *
 * Two states are load-bearing:
 *
 * - `BLOCKED_BY_FLAG` is not a failure and not a success. It carries the
 *   `DryRunResult` describing exactly what would have been sent.
 * - `PROVIDER_CONFIRMED` is only ever reached from a provider response, and
 *   `RECONCILED` only after re-reading the object and finding the change
 *   actually in place (AGENTS.md rule 3).
 */
import { z } from 'zod';
import {
  type CommandState,
  type DomainErrorCode,
  type DryRunResult,
  type ExternalCommand,
  type FeatureFlags,
  type RoleBudgetLimit,
  DEFAULT_SCALE_COOLDOWN_HOURS,
  DEFAULT_SCALE_STEP_PCT,
  DomainError,
  canWriteMeta,
  formatMoneyDe,
  money,
  nowIso,
  redact,
} from '@am/domain';
import { logger } from '@am/observability';
import {
  type DraftCreationResult,
  type DraftIdempotencyStore,
  createPausedDraft,
  draftPlanSchema,
} from './draft';
import { assertOutboundAllowed } from './import-mode';
import type {
  MetaEntityRef,
  MetaEntitySnapshot,
  MetaMutationResult,
  MetaProvider,
} from './provider';
import { DEFAULT_META_RETRY, type RetryConfig, withRateLimitRetry } from './retry';

/* -------------------------------------------------------------------------- */
/* State machine                                                               */
/* -------------------------------------------------------------------------- */

export const COMMAND_TRANSITIONS: Readonly<Record<CommandState, readonly CommandState[]>> = {
  PENDING_CONFIRMATION: ['QUEUED', 'FAILED', 'BLOCKED_BY_FLAG'],
  QUEUED: ['IN_FLIGHT', 'FAILED', 'BLOCKED_BY_FLAG'],
  IN_FLIGHT: ['PROVIDER_CONFIRMED', 'FAILED', 'BLOCKED_BY_FLAG'],
  PROVIDER_CONFIRMED: ['RECONCILED', 'FAILED'],
  FAILED: ['QUEUED'],
  RECONCILED: [],
  BLOCKED_BY_FLAG: ['QUEUED'],
};

export function canTransitionCommand(from: CommandState, to: CommandState): boolean {
  return COMMAND_TRANSITIONS[from].includes(to);
}

function transition(command: ExternalCommand, to: CommandState): ExternalCommand {
  if (command.state === to) return command;
  if (!canTransitionCommand(command.state, to)) {
    throw new DomainError('CONFLICT', {
      messageDe: `Der Befehl kann nicht von „${command.state}" nach „${to}" wechseln.`,
      details: { from: command.state, to, command_id: command.id },
    });
  }
  return { ...command, state: to };
}

/** PENDING_CONFIRMATION → QUEUED. The operator's explicit confirmation. */
export function confirmCommand(command: ExternalCommand): ExternalCommand {
  return transition(command, 'QUEUED');
}

/* -------------------------------------------------------------------------- */
/* Command input                                                               */
/* -------------------------------------------------------------------------- */

export const commandTargetSchema = z.object({
  level: z.enum(['CAMPAIGN', 'ADSET', 'AD', 'AD_CREATIVE']),
  externalId: z.string().min(1).max(64),
});

/**
 * The typed view of `ExternalCommand.requestPreview`. Keeping the execution
 * input inside the command record is what makes a retry after a process restart
 * possible without a side table.
 */
export const commandInputSchema = z.object({
  target: commandTargetSchema.nullable().default(null),
  currentDailyBudgetMinor: z.number().int().min(0).nullable().default(null),
  dailyBudgetMinor: z.number().int().min(0).nullable().default(null),
  currency: z.string().length(3).default('EUR'),
  adExternalId: z.string().max(64).nullable().default(null),
  creativeExternalId: z.string().max(64).nullable().default(null),
  draftPlan: z.unknown().nullable().default(null),
});
export type CommandInput = z.infer<typeof commandInputSchema>;

export function parseCommandInput(command: ExternalCommand): CommandInput {
  const parsed = commandInputSchema.safeParse(command.requestPreview);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Die Befehlsdaten sind unvollständig. Der Meta-Befehl wurde nicht ausgeführt.',
      details: {
        command_id: command.id,
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  }
  return parsed.data;
}

function requireTarget(input: CommandInput, command: ExternalCommand): MetaEntityRef {
  if (!input.target) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Dem Meta-Befehl fehlt das Zielobjekt.',
      details: { command_id: command.id, kind: command.kind },
    });
  }
  return input.target;
}

/* -------------------------------------------------------------------------- */
/* Budget guards                                                               */
/* -------------------------------------------------------------------------- */

export const DEFAULT_BUDGET_STEP_PCT = DEFAULT_SCALE_STEP_PCT;
export const DEFAULT_BUDGET_COOLDOWN_HOURS = DEFAULT_SCALE_COOLDOWN_HOURS;

/** The default +20 % step. Rounded to whole minor units. */
export function proposeScaledBudget(
  currentDailyBudgetMinor: number,
  stepPct: number = DEFAULT_BUDGET_STEP_PCT,
): number {
  return Math.round(currentDailyBudgetMinor * (1 + stepPct));
}

export interface BudgetGuardInput {
  currentDailyBudgetMinor: number;
  requestedDailyBudgetMinor: number;
  currency?: string;
  limits: RoleBudgetLimit;
  /** Scale actions already performed on this object in the rolling window. */
  scalesInLast24h?: number;
  lastScaleAt?: string | null;
  cooldownHours?: number;
  now?: string;
}

export type BudgetGuardVerdict =
  | { allowed: true; direction: 'INCREASE' | 'DECREASE'; stepPct: number }
  | { allowed: false; direction: 'INCREASE' | 'DECREASE' | 'NONE'; stepPct: number; error: DomainError };

/**
 * Budget authority. A request outside the limits is **refused**, never clamped:
 * silently scaling by less than the operator asked for hides the limit and
 * makes the audit trail lie about what was requested (spec §21, acceptance
 * criterion 24).
 */
export function guardBudgetChange(input: BudgetGuardInput): BudgetGuardVerdict {
  const currency = input.currency ?? 'EUR';
  const current = input.currentDailyBudgetMinor;
  const requested = input.requestedDailyBudgetMinor;
  const limits = input.limits;

  if (requested < 0) {
    return {
      allowed: false,
      direction: 'NONE',
      stepPct: 0,
      error: new DomainError('VALIDATION_FAILED', {
        messageDe: 'Ein negatives Tagesbudget ist nicht zulässig.',
        details: { requested },
      }),
    };
  }

  if (requested === current) {
    return {
      allowed: false,
      direction: 'NONE',
      stepPct: 0,
      error: new DomainError('VALIDATION_FAILED', {
        messageDe: 'Das angeforderte Tagesbudget entspricht dem aktuellen Budget.',
        details: { current, requested },
      }),
    };
  }

  if (requested < current) {
    if (!limits.mayPause) {
      return {
        allowed: false,
        direction: 'DECREASE',
        stepPct: (requested - current) / Math.max(1, current),
        error: new DomainError('FORBIDDEN', {
          messageDe: `Ihre Rolle (${limits.role}) darf das Budget nicht reduzieren.`,
          details: { role: limits.role },
        }),
      };
    }
    return {
      allowed: true,
      direction: 'DECREASE',
      stepPct: (requested - current) / Math.max(1, current),
    };
  }

  // Increase.
  if (current <= 0) {
    return {
      allowed: false,
      direction: 'INCREASE',
      stepPct: Number.POSITIVE_INFINITY,
      error: new DomainError('BUDGET_LIMIT_EXCEEDED', {
        messageDe:
          'Das aktuelle Tagesbudget ist 0. Eine relative Erhöhung ist nicht bewertbar – bitte das Budget direkt in Meta setzen und danach hier synchronisieren.',
        details: { current, requested },
      }),
    };
  }

  const stepPct = (requested - current) / current;

  if (stepPct > limits.maxSingleIncreasePct + 1e-9) {
    return {
      allowed: false,
      direction: 'INCREASE',
      stepPct,
      error: new DomainError('BUDGET_LIMIT_EXCEEDED', {
        messageDe: `Die Erhöhung um ${(stepPct * 100).toFixed(1)} % überschreitet das Rollenlimit von ${(limits.maxSingleIncreasePct * 100).toFixed(0)} %. Die Anfrage wurde abgelehnt und nicht gekürzt.`,
        details: {
          role: limits.role,
          step_pct: stepPct,
          max_single_increase_pct: limits.maxSingleIncreasePct,
          current,
          requested,
        },
      }),
    };
  }

  if (requested > limits.maxDailyBudgetMinor) {
    return {
      allowed: false,
      direction: 'INCREASE',
      stepPct,
      error: new DomainError('BUDGET_LIMIT_EXCEEDED', {
        messageDe: `Das Zielbudget ${formatMoneyDe(money(requested, currency))} überschreitet die Obergrenze ${formatMoneyDe(money(limits.maxDailyBudgetMinor, currency))} Ihrer Rolle.`,
        details: {
          role: limits.role,
          requested,
          max_daily_budget_minor: limits.maxDailyBudgetMinor,
        },
      }),
    };
  }

  const scales = input.scalesInLast24h ?? 0;
  if (scales >= limits.maxScalesPer24h) {
    return {
      allowed: false,
      direction: 'INCREASE',
      stepPct,
      error: new DomainError('BUDGET_LIMIT_EXCEEDED', {
        messageDe: `Es wurde in den letzten 24 Stunden bereits ${scales}× skaliert. Ihre Rolle erlaubt ${limits.maxScalesPer24h} Skalierung(en) pro 24 Stunden.`,
        details: { role: limits.role, scales_in_last_24h: scales },
      }),
    };
  }

  if (input.lastScaleAt) {
    const cooldownHours = input.cooldownHours ?? DEFAULT_BUDGET_COOLDOWN_HOURS;
    const elapsedMs = new Date(input.now ?? nowIso()).getTime() - new Date(input.lastScaleAt).getTime();
    if (elapsedMs < cooldownHours * 3_600_000) {
      const remainingHours = Math.ceil((cooldownHours * 3_600_000 - elapsedMs) / 3_600_000);
      return {
        allowed: false,
        direction: 'INCREASE',
        stepPct,
        error: new DomainError('BUDGET_LIMIT_EXCEEDED', {
          messageDe: `Die letzte Skalierung liegt weniger als ${cooldownHours} Stunden zurück. Nächste Skalierung frühestens in ${remainingHours} Stunde(n).`,
          details: { last_scale_at: input.lastScaleAt, cooldown_hours: cooldownHours },
        }),
      };
    }
  }

  return { allowed: true, direction: 'INCREASE', stepPct };
}

/* -------------------------------------------------------------------------- */
/* Idempotency ledger                                                          */
/* -------------------------------------------------------------------------- */

export interface CommandLedgerEntry {
  idempotencyKey: string;
  commandId: string;
  kind: ExternalCommand['kind'];
  outcome: MetaMutationResult | DraftCreationResult;
  storedAt: string;
}

export interface CommandLedger {
  get(idempotencyKey: string): Promise<CommandLedgerEntry | null>;
  put(entry: CommandLedgerEntry): Promise<void>;
}

export function createInMemoryCommandLedger(): CommandLedger {
  const entries = new Map<string, CommandLedgerEntry>();
  return {
    get: async (key) => entries.get(key) ?? null,
    put: async (entry) => {
      entries.set(entry.idempotencyKey, entry);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

export interface CommandExecutionOptions {
  ledger?: CommandLedger;
  draftStore?: DraftIdempotencyStore;
  retry?: RetryConfig;
  now?: string;
  /** Required for INCREASE_BUDGET / DECREASE_BUDGET. */
  budget?: {
    limits: RoleBudgetLimit;
    scalesInLast24h?: number;
    lastScaleAt?: string | null;
    cooldownHours?: number;
  };
}

export interface CommandExecutionResult {
  command: ExternalCommand;
  outcome: MetaMutationResult | DraftCreationResult | null;
  dryRun: DryRunResult | null;
  errorCode: DomainErrorCode | null;
  errorDe: string | null;
  /** Backoff actually applied, in order. Empty when the first attempt worked. */
  backoffDelaysMs: number[];
  /** True when the ledger answered and no provider call was made. */
  idempotentReplay: boolean;
}

function isDryRunResult(value: unknown): value is DryRunResult {
  return typeof value === 'object' && value !== null && (value as DryRunResult).dryRun === true;
}

/**
 * Executes one command end to end.
 *
 * The idempotency key is checked before anything else that could produce a
 * second object: a retry after a timeout re-uses the stored outcome instead of
 * creating a duplicate campaign.
 */
export async function executeCommand(
  command: ExternalCommand,
  provider: MetaProvider,
  flags: FeatureFlags,
  options: CommandExecutionOptions = {},
): Promise<CommandExecutionResult> {
  const now = options.now ?? nowIso();
  const retry = options.retry ?? DEFAULT_META_RETRY;

  if (command.state === 'PENDING_CONFIRMATION') {
    return {
      command,
      outcome: null,
      dryRun: null,
      errorCode: 'APPROVAL_REQUIRED',
      errorDe: 'Der Befehl wurde noch nicht bestätigt und deshalb nicht ausgeführt.',
      backoffDelaysMs: [],
      idempotentReplay: false,
    };
  }
  if (command.state === 'PROVIDER_CONFIRMED' || command.state === 'RECONCILED') {
    return {
      command,
      outcome: null,
      dryRun: null,
      errorCode: null,
      errorDe: null,
      backoffDelaysMs: [],
      idempotentReplay: true,
    };
  }

  // Idempotency: a replay never produces a second external object.
  const stored = options.ledger ? await options.ledger.get(command.idempotencyKey) : null;
  if (stored) {
    return {
      command: {
        ...command,
        state: 'PROVIDER_CONFIRMED',
        confirmedAt: command.confirmedAt ?? stored.storedAt,
        providerResponseRedacted: redact(stored.outcome),
      },
      outcome: stored.outcome,
      dryRun: null,
      errorCode: null,
      errorDe: null,
      backoffDelaysMs: [],
      idempotentReplay: true,
    };
  }

  const input = parseCommandInput(command);

  if (!canWriteMeta(flags)) {
    const preview = buildDryRunPreview(command, input);
    return {
      command: {
        ...transition(command, 'BLOCKED_BY_FLAG'),
        providerResponseRedacted: null,
        error: null,
      },
      outcome: null,
      dryRun: preview,
      errorCode: 'EXTERNAL_WRITES_DISABLED',
      errorDe: preview.blockedByDe,
      backoffDelaysMs: [],
      idempotentReplay: false,
    };
  }

  assertOutboundAllowed(`meta.command.${command.kind}`);

  // Budget authority is checked before the object is touched.
  if (command.kind === 'INCREASE_BUDGET' || command.kind === 'DECREASE_BUDGET') {
    const verdict = guardBudget(command, input, options, now);
    if (!verdict.allowed) {
      return failure(command, verdict.error, []);
    }
  }

  const queued = command.state === 'QUEUED' ? command : transition(command, 'QUEUED');
  const inFlight = {
    ...transition(queued, 'IN_FLIGHT'),
    attemptCount: command.attemptCount + 1,
  };

  try {
    const attempt = await withRateLimitRetry(
      `meta.command.${command.kind}:${command.idempotencyKey}`,
      () => runCommand(command, input, provider, flags, options),
      retry,
    );

    if (isDryRunResult(attempt.value)) {
      return {
        command: { ...transition(inFlight, 'BLOCKED_BY_FLAG'), providerResponseRedacted: null },
        outcome: null,
        dryRun: attempt.value,
        errorCode: 'EXTERNAL_WRITES_DISABLED',
        errorDe: attempt.value.blockedByDe,
        backoffDelaysMs: attempt.delaysMs,
        idempotentReplay: false,
      };
    }

    const outcome = attempt.value;
    await options.ledger?.put({
      idempotencyKey: command.idempotencyKey,
      commandId: command.id,
      kind: command.kind,
      outcome,
      storedAt: now,
    });

    const confirmed: ExternalCommand = {
      ...transition(inFlight, 'PROVIDER_CONFIRMED'),
      confirmedAt: now,
      providerResponseRedacted: redact(outcome),
      error: null,
    };

    logger.info('meta_command_confirmed', {
      command_id: command.id,
      kind: command.kind,
      idempotency_key: command.idempotencyKey,
      attempts: attempt.attempts,
    });

    return {
      command: confirmed,
      outcome,
      dryRun: null,
      errorCode: null,
      errorDe: null,
      backoffDelaysMs: attempt.delaysMs,
      idempotentReplay: false,
    };
  } catch (error) {
    const delays = delaysFrom(error);
    return failure(inFlight, error, delays);
  }
}

function delaysFrom(error: unknown): number[] {
  if (!(error instanceof DomainError)) return [];
  const value = error.details.delays_ms;
  return Array.isArray(value) ? (value as number[]) : [];
}

function failure(
  command: ExternalCommand,
  error: unknown,
  backoffDelaysMs: number[],
): CommandExecutionResult {
  const domainError =
    error instanceof DomainError
      ? error
      : new DomainError('PROVIDER_ERROR', {
          messageDe: 'Der Meta-Befehl ist fehlgeschlagen.',
          cause: error,
        });

  logger.warn('meta_command_failed', {
    command_id: command.id,
    kind: command.kind,
    code: domainError.code,
    retryable: domainError.retryable,
  });

  return {
    command: {
      ...(command.state === 'FAILED' ? command : transition(command, 'FAILED')),
      error: domainError.messageDe,
      providerResponseRedacted: null,
    },
    outcome: null,
    dryRun: null,
    errorCode: domainError.code,
    errorDe: domainError.messageDe,
    backoffDelaysMs,
    idempotentReplay: false,
  };
}

function guardBudget(
  command: ExternalCommand,
  input: CommandInput,
  options: CommandExecutionOptions,
  now: string,
): BudgetGuardVerdict {
  if (!options.budget) {
    return {
      allowed: false,
      direction: 'NONE',
      stepPct: 0,
      error: new DomainError('FORBIDDEN', {
        messageDe: 'Für Budgetänderungen fehlt das Rollenlimit. Der Befehl wurde nicht ausgeführt.',
        details: { command_id: command.id },
      }),
    };
  }
  if (input.dailyBudgetMinor === null || input.currentDailyBudgetMinor === null) {
    return {
      allowed: false,
      direction: 'NONE',
      stepPct: 0,
      error: new DomainError('VALIDATION_FAILED', {
        messageDe:
          'Für die Budgetänderung fehlen das aktuelle oder das gewünschte Tagesbudget.',
        details: { command_id: command.id },
      }),
    };
  }
  return guardBudgetChange({
    currentDailyBudgetMinor: input.currentDailyBudgetMinor,
    requestedDailyBudgetMinor: input.dailyBudgetMinor,
    currency: input.currency,
    limits: options.budget.limits,
    scalesInLast24h: options.budget.scalesInLast24h ?? 0,
    lastScaleAt: options.budget.lastScaleAt ?? null,
    cooldownHours: options.budget.cooldownHours,
    now,
  });
}

async function runCommand(
  command: ExternalCommand,
  input: CommandInput,
  provider: MetaProvider,
  flags: FeatureFlags,
  options: CommandExecutionOptions,
): Promise<MetaMutationResult | DraftCreationResult | DryRunResult> {
  switch (command.kind) {
    case 'PAUSE_ENTITY':
      return provider.pauseEntity({
        ref: requireTarget(input, command),
        idempotencyKey: command.idempotencyKey,
      });
    case 'RESUME_ENTITY':
      return provider.resumeEntity({
        ref: requireTarget(input, command),
        idempotencyKey: command.idempotencyKey,
      });
    case 'INCREASE_BUDGET':
    case 'DECREASE_BUDGET':
      return provider.updateBudget({
        ref: requireTarget(input, command),
        dailyBudgetMinor: input.dailyBudgetMinor as number,
        currency: input.currency,
        idempotencyKey: command.idempotencyKey,
      });
    case 'PAUSE_CREATIVE':
      if (!input.adExternalId) {
        throw new DomainError('VALIDATION_FAILED', {
          messageDe: 'Zum Pausieren eines Creatives fehlt die Anzeigen-ID.',
          details: { command_id: command.id },
        });
      }
      return provider.pauseCreative({
        adExternalId: input.adExternalId,
        creativeExternalId: input.creativeExternalId,
        idempotencyKey: command.idempotencyKey,
      });
    case 'CREATE_DRAFT_CAMPAIGN': {
      const plan = draftPlanSchema.parse(input.draftPlan);
      return createPausedDraft(plan, provider, flags, { store: options.draftStore });
    }
    default:
      throw new DomainError('VALIDATION_FAILED', {
        messageDe: 'Unbekannter Meta-Befehl.',
        details: { kind: command.kind },
      });
  }
}

function buildDryRunPreview(command: ExternalCommand, input: CommandInput): DryRunResult {
  return {
    dryRun: true,
    provider: 'META',
    operation: `meta.command.${command.kind}`,
    wouldSend: {
      kind: command.kind,
      idempotency_key: command.idempotencyKey,
      target: input.target,
      daily_budget_minor: input.dailyBudgetMinor,
      currency: input.currency,
      ad_external_id: input.adExternalId,
      creative_external_id: input.creativeExternalId,
      has_draft_plan: input.draftPlan !== null,
    },
    blockedByDe:
      'Meta-Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED / META_MUTATIONS_ENABLED = false). Es wurde nichts gesendet.',
  };
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

export interface CommandDiscrepancy {
  kind: 'ENTITY_MISSING' | 'STATUS_MISMATCH' | 'BUDGET_MISMATCH';
  expected: unknown;
  actual: unknown;
  noteDe: string;
}

export interface ReconcileResult {
  ok: boolean;
  command: ExternalCommand;
  snapshot: MetaEntitySnapshot | null;
  discrepancy: CommandDiscrepancy | null;
}

function expectedStatusFor(kind: ExternalCommand['kind']): 'ACTIVE' | 'PAUSED' | null {
  switch (kind) {
    case 'PAUSE_ENTITY':
    case 'PAUSE_CREATIVE':
    case 'CREATE_DRAFT_CAMPAIGN':
      return 'PAUSED';
    case 'RESUME_ENTITY':
      return 'ACTIVE';
    default:
      return null;
  }
}

/**
 * Re-reads the object from Meta and confirms the change actually took effect.
 *
 * A provider `200 OK` is not the end of the story: an ad set can be paused by a
 * parent campaign, a budget change can be rejected asynchronously. Only after
 * this read does a command reach `RECONCILED`.
 */
export async function reconcile(
  command: ExternalCommand,
  provider: MetaProvider,
  options: { now?: string } = {},
): Promise<ReconcileResult> {
  const now = options.now ?? nowIso();
  if (command.state !== 'PROVIDER_CONFIRMED') {
    throw new DomainError('CONFLICT', {
      messageDe: 'Nur bestätigte Befehle können abgeglichen werden.',
      details: { state: command.state, command_id: command.id },
    });
  }

  const input = parseCommandInput(command);
  const ref: MetaEntityRef | null =
    input.target ?? (input.adExternalId ? { level: 'AD', externalId: input.adExternalId } : null);

  if (!ref) {
    // A draft creation has no single target; the creation result already
    // carried the confirmed ids and each object's status.
    return {
      ok: true,
      command: { ...transition(command, 'RECONCILED'), reconciledAt: now },
      snapshot: null,
      discrepancy: null,
    };
  }

  const snapshot = await provider.getEntity(ref);
  if (!snapshot) {
    return {
      ok: false,
      command,
      snapshot: null,
      discrepancy: {
        kind: 'ENTITY_MISSING',
        expected: ref.externalId,
        actual: null,
        noteDe: 'Das Objekt ist bei Meta nicht mehr auffindbar. Der Abgleich ist fehlgeschlagen.',
      },
    };
  }

  const expectedStatus = expectedStatusFor(command.kind);
  if (expectedStatus && snapshot.status !== expectedStatus) {
    return {
      ok: false,
      command,
      snapshot,
      discrepancy: {
        kind: 'STATUS_MISMATCH',
        expected: expectedStatus,
        actual: snapshot.status,
        noteDe: `Meta meldet den Status „${snapshot.status}", erwartet wurde „${expectedStatus}". Die Änderung ist nicht wirksam.`,
      },
    };
  }

  if (
    (command.kind === 'INCREASE_BUDGET' || command.kind === 'DECREASE_BUDGET') &&
    input.dailyBudgetMinor !== null
  ) {
    const actual = snapshot.dailyBudget?.amountMinor ?? null;
    if (actual !== input.dailyBudgetMinor) {
      return {
        ok: false,
        command,
        snapshot,
        discrepancy: {
          kind: 'BUDGET_MISMATCH',
          expected: input.dailyBudgetMinor,
          actual,
          noteDe: `Meta führt ein Tagesbudget von ${actual === null ? '—' : formatMoneyDe(money(actual, input.currency))}, erwartet wurde ${formatMoneyDe(money(input.dailyBudgetMinor, input.currency))}.`,
        },
      };
    }
  }

  return {
    ok: true,
    command: { ...transition(command, 'RECONCILED'), reconciledAt: now },
    snapshot,
    discrepancy: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Construction helper                                                         */
/* -------------------------------------------------------------------------- */

export interface NewCommandInput {
  id: string;
  kind: ExternalCommand['kind'];
  idempotencyKey: string;
  requestedBy: string;
  requestedAt?: string;
  input: Partial<CommandInput>;
  campaignId?: string | null;
}

/** Builds a command in `PENDING_CONFIRMATION`: nothing runs without a confirm. */
export function newCommand(input: NewCommandInput): ExternalCommand {
  return {
    id: input.id,
    provider: 'META',
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    state: 'PENDING_CONFIRMATION',
    requestedBy: input.requestedBy,
    requestedAt: input.requestedAt ?? nowIso(),
    confirmedAt: null,
    reconciledAt: null,
    requestPreview: commandInputSchema.parse(input.input) as Record<string, unknown>,
    providerResponseRedacted: null,
    error: null,
    attemptCount: 0,
    campaign_id: input.campaignId ?? null,
  };
}
