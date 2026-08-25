import { DomainError, type AuditAction, type Permission, redact } from '@am/domain';
import { logger } from '@am/observability';
import { type ActionResult, actionOk, toActionError } from './action-result';
import { requirePermission, type SessionUser } from './permissions';
import { getSessionUser } from './session';

/**
 * Server-action wrapper.
 *
 * Every mutating action in the console goes through here, which is what makes
 * three properties uniform instead of per-handler discipline:
 *
 * 1. the permission is checked before the handler runs,
 * 2. failures become a German, renderable `ActionResult` rather than a thrown
 *    stack trace or a blank error page,
 * 3. the action is audited with a redacted payload and a correlation id.
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

let auditSink: AuditSink | null = null;

/**
 * Installed once at startup by the data layer. Kept as an injection point so
 * `@am/console` does not have to import a repository just to write an audit row,
 * and so tests can capture audit entries.
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

      const ctx: ActionContext = {
        user: authorized,
        correlationId,
        audit: async (entry) => {
          if (!auditSink) {
            log.warn('audit_sink_missing', { audit_action: entry.action });
            return;
          }
          await auditSink({
            ...entry,
            before: redact(entry.before ?? null),
            after: redact(entry.after ?? null),
            workspaceId: authorized.workspaceId,
            actorId: authorized.id,
            actorLabel: authorized.displayName,
            correlationId,
            occurredAt: new Date().toISOString(),
          });
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
