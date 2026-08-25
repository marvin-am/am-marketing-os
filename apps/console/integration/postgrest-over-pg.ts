import { createRequire } from 'node:module';
import { createPostgrestOverPg, type PgConnectionLike } from './fixtures/postgrest-over-pg';

/**
 * A PostgREST-shaped client that opens its own connection.
 *
 * The translation itself lives in `./fixtures/postgrest-over-pg`, which is
 * connection-scoped — that is the general form, and the one the RLS tests need,
 * because a policy is evaluated on the connection that carries the session. A
 * second copy of the builder existed here for a while, and the two had already
 * diverged: writing either one surfaced the same fidelity traps independently
 * (`bigint`/`numeric` arrive as strings from `pg` where PostgREST sends JSON
 * numbers; `date`/`timestamptz` arrive as objects where it sends ISO strings).
 * A harness that lies differently in two places is worse than one that lies
 * consistently, so there is one translation and this is a wrapper around it.
 *
 * What is faked is only the transport. The repository code, the schema, its
 * constraints, its triggers and its policies are real and evaluated by Postgres.
 */

interface PgModule {
  Client: new (config: { connectionString: string }) => PgConnectionLike & {
    connect(): Promise<void>;
    end(): Promise<void>;
  };
}

const pg = createRequire(new URL('../../../packages/db/package.json', import.meta.url))(
  'pg',
) as PgModule;

export interface PgBackedClient {
  /** Structurally the `DbClient` the repositories take. */
  client: unknown;
  close(): Promise<void>;
}

export async function createPgDbClient(connectionString: string): Promise<PgBackedClient> {
  const connection = new pg.Client({ connectionString });
  await connection.connect();

  return {
    client: createPostgrestOverPg(connection),
    close: () => connection.end(),
  };
}
