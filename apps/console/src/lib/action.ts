import { DomainError, type AuditAction, type Permission, redact } from '@am/domain';
import { logger } from '@am/observability';
import { createAuditSink } from '@/server/audit-sink';
import { type ActionResult, actionOk, toActionError } from './action-result';
import { requirePermission, type SessionUser } from './permissions';
import { getSessionUser } from './session';

/**
 * Server-action wrapper.
 *
 * Every mutating action in the console goes through here, which is what makes
 * four properties uniform instead of per-handler discipline:
 *
 * 1. the permission is checked before the handler runs,
 * 2. failures become a German, renderable `ActionResult` rather than a thrown
 *    stack trace or a blank error page,
 * 3. the action is audited with a redacted payload and a correlation id,
 * 4. an action whose entry could not be recorded at all is refused before it
 *    runs, so the console never performs a change it cannot account for.
 */

export interface ActionContext {
  user: SessionUser;
  correlationId: string;
  /** Records an audit entry inside the action's correlation scope. */
  audit: (entry: AuditEntryInput) => Promise<void>;
}

export interface AuditEntryInput {
  action: AuditAction;
  entityType: string;
  entityId: string;
  summaryDe: string;
  campaignId?: string | null;
  before?: unknown;
  after?: unknown;
}

export type AuditSink = (entry: AuditEntryInput & {
  workspaceId: string;
  actorId: string;
  actorLabel: string;
  correlationId: string;
  occurredAt: string;
}) => Promise<void>;

/**
 * The configured sink, installed at module load rather than by a startup hook.
 *
 * `@/server/audit-sink` is the one place that decides which store the trail goes
 * to; this is only where the framework picks that choice up. Doing it here and
 * not from `instrumentation.ts` is deliberate: Next.js compiles the
 * instrumentation entry into its own bundle, so a singleton assigned there is
 * not reliably the singleton the server-action bundle reads, and an installer
 * that silently misses is the defect this file exists to rule out.
 */
let auditSink: AuditSink | null = createAuditSink();

/**
 * Replaces the installed sink. Kept as an injection point so `@am/console` does
 * not have to import a repository just to write an audit row, and so tests can
 * capture audit entries — or remove the sink to prove that its absence is
 * refused rather than shrugged off.
 */
export function setAuditSink(sink: AuditSink | null): void {
  auditSink = sink;
}

export interface DefineActionOptions {
  permission: Permission;
  /** Used in log lines and as the audit correlation prefix. */
  name: string;
}

export function defineAction<TInput, TOutput>(
  options: DefineActionOptions,
  handler: (input: TInput, ctx: ActionContext) => Promise<ActionResult<TOutput> | TOutput>,
): (input: TInput) => Promise<ActionResult<TOutput>> {
  return async (input: TInput): Promise<ActionResult<TOutput>> => {
    const correlationId = `${options.name}:${globalThis.crypto.randomUUID()}`;
    const log = logger.child({ action: options.name, correlation_id: correlationId });

    try {
      const user = await getSessionUser();
      const authorized = requirePermission(user, options.permission);

      /*
       * The trail is a precondition of acting, not a side effect of having
       * acted. A handler decides only while it runs whether it audits, and by
       * the time it calls `ctx.audit` its business write has already happened —
       * so this is the last moment at which refusing still costs nothing. An
       * absent sink is a composition failure that affects every action alike;
       * mutating on through it produces exactly the state this check exists to
       * prevent, changes nobody can account for afterwards.
       */
      const sink = auditSink;
      if (!sink) {
        log.error('audit_sink_missing', { permission: options.permission });
        throw new DomainError('INTERNAL', {
          messageDe:
            'Das Audit-Log ist nicht verfügbar. Die Aktion wurde nicht ausgeführt, weil sie nicht protokolliert werden könnte.',
          details: { reason: 'audit_sink_missing', action: options.name },
          retryable: false,
        });
      }

      const ctx: ActionContext = {
        user: authorized,
        correlationId,
        audit: async (entry) => {
          const row = {
            ...entry,
            before: redact(entry.before ?? null),
            after: redact(entry.after ?? null),
            workspaceId: authorized.workspaceId,
            actorId: authorized.id,
            actorLabel: authorized.displayName,
            correlationId,
            occurredAt: new Date().toISOString(),
          };
          try {
            await sink(row);
          } catch (error) {
            /*
             * The write this entry describes has already been performed. Turning
             * a failed append into a failed action would report a change that
             * happened as one that did not, and invite the operator to repeat
             * it — so the business outcome stands and the gap is escalated at
             * error level with the redacted row, which is replayable from the
             * log drain. It is not a warning: the trail is now incomplete.
             */
            log.error('audit_write_failed', {
              audit_action: entry.action,
              entity_type: entry.entityType,
              entity_id: entry.entityId,
              entry: row,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };

      const result = await handler(input, ctx);
      if (isActionResult<TOutput>(result)) return result;
      return actionOk(result);
    } catch (error) {
      if (error instanceof DomainError) {
        log.warn('action_refused', { code: error.code, details: redact(error.details) });
      } else {
        log.error('action_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return toActionError<TOutput>(error);
    }
  };
}

function isActionResult<T>(value: unknown): value is ActionResult<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof (value as { status: unknown }).status === 'string' &&
    ['ok', 'dry_run', 'error'].includes((value as { status: string }).status)
  );
}

/**
 * Read-side guard for server components. Throws `UNAUTHENTICATED` / `FORBIDDEN`,
 * which the route's error boundary renders as a German message.
 */
export async function requireUser(permission: Permission = 'campaign.read'): Promise<SessionUser> {
  const user = await getSessionUser();
  return requirePermission(user, permission);
}
