import { getServerEnv } from '@am/config';
import { DomainError } from '@am/domain';
import { connectWithPg, type SqlProbeConnection } from '@am/db';

/**
 * The transactional write path of the Campaign Room.
 *
 * PostgREST answers one statement per request, so a write that has to produce
 * several rows — an approval decision plus the downstream approvals it
 * invalidates plus the audit row that accounts for the cascade — cannot be made
 * atomic through the repositories. `packages/db/src/sql.ts` already names the
 * way out: a caller that holds its own `pg` transaction runs the same statements
 * the RPCs run, and `ENQUEUE_OUTBOX_EVENT_SQL` exists precisely so a business
 * write and its outbox row commit together.
 *
 * Two properties this file is responsible for:
 *
 * 1. **All or nothing.** Every statement of one operation runs between `begin`
 *    and `commit`; any failure rolls the whole thing back. A campaign whose
 *    state moved but whose audit row was refused is exactly the state
 *    `defineAction` refuses to create, and it must not be reachable from here
 *    either.
 * 2. **RLS still applies.** `DATABASE_URL` connects as the owner, which would
 *    bypass every policy in `0012_rls.sql` and every capability gate in
 *    `0018_role_gated_writes.sql` — the ones that decide whether this operator
 *    may approve a strategy at all. The transaction therefore drops to
 *    `authenticated` and sets the same request GUCs PostgREST sets, so a write
 *    that the operator's role does not permit fails here as it would there.
 */

export interface CampaignTransaction {
  query<Row extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
}

export interface TransactionActor {
  /** Profile id the policies see as `auth.uid()`. */
  profileId: string | null;
}

export type TransactionRunner = <T>(
  actor: TransactionActor,
  work: (tx: CampaignTransaction) => Promise<T>,
) => Promise<T>;

export interface PgTransactionOptions {
  connectionString?: string | null;
  /** Postgres role the statements run as. `authenticated` keeps RLS in force. */
  role?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A transaction runner, or `null` when no `DATABASE_URL` is configured.
 *
 * `null` rather than a throwing stub: a caller has to be able to tell the
 * operator that the atomic path is unavailable instead of discovering it
 * halfway through a write.
 */
export function createPgTransactionRunner(
  options: PgTransactionOptions = {},
): TransactionRunner | null {
  const connectionString =
    options.connectionString === undefined
      ? (getServerEnv().DATABASE_URL ?? null)
      : options.connectionString;
  if (!connectionString) return null;

  const role = options.role ?? 'authenticated';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function runInTransaction(actor, work) {
    const connection = await connectWithPg({ connectionString, timeoutMs });
    try {
      return await withTransaction(connection, role, actor, work);
    } finally {
      await connection.close().catch(() => undefined);
    }
  };
}

/**
 * Wraps an already-open connection.
 *
 * Exported so an integration test can drive the same code against a scratch
 * database it opened itself, rather than testing a second implementation of the
 * begin/commit/rollback dance.
 */
export async function withTransaction<T>(
  connection: SqlProbeConnection,
  role: string,
  actor: TransactionActor,
  work: (tx: CampaignTransaction) => Promise<T>,
): Promise<T> {
  const tx: CampaignTransaction = {
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      const result = await connection.query<Row>(text, values);
      return result.rows;
    },
  };

  await connection.query('begin');
  try {
    // `set local` is scoped to this transaction, so the connection cannot leak
    // an elevated or a downgraded context into whatever runs next on it.
    await connection.query(`set local role ${quoteIdentifier(role)}`);
    if (actor.profileId) {
      // Both spellings: the Supabase-hosted `auth.uid()` reads the JSON claims
      // object, the shim in `0001_extensions.sql` reads the flat GUC.
      await connection.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        actor.profileId,
      ]);
      await connection.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: actor.profileId, role }),
      ]);
    }
    const outcome = await work(tx);
    await connection.query('commit');
    return outcome;
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  }
}

/**
 * Role names are configuration, never user input, but the name is interpolated
 * rather than bound — `set role` takes no parameters — so it is validated
 * instead of trusted.
 */
function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new DomainError('VALIDATION_FAILED', {
      messageDe: 'Der konfigurierte Datenbank-Rollenname ist ungültig.',
      details: { role: value },
    });
  }
  return `"${value}"`;
}
