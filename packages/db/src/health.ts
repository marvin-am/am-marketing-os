import { createRequire } from 'node:module';
import { getServerEnv, resolveProviderMode, type ProviderMode } from '@am/config';
import {
  DomainError,
  nowIso,
  rollUpHealth,
  type ConnectionState,
  type HealthCheck,
  type HealthStatus,
  type ProviderHealth,
} from '@am/domain';
import { instrumented } from '@am/observability';

/**
 * Supabase health probe.
 *
 * The three things the integrations screen asserts about Supabase — the project
 * answers, row level security is on, the creative buckets exist — are all
 * statements about a database, and a database is the only thing that can make
 * them. A service role key sitting in the environment says none of it, so
 * nothing here is derived from a variable being non-empty (AGENTS.md rule 1).
 *
 * What the probe reads is exactly what `supabase/migrations/0012_rls.sql`
 * asserts about itself (`pg_class.relrowsecurity` over every base table in
 * `public`) and what `0014_storage.sql` creates (`storage.buckets`). Anything
 * the probe could not establish reports as unknown, never as passed.
 *
 * It runs while the integrations page renders, so it carries its own deadline
 * and never propagates a failure out to the caller.
 */

export const SUPABASE_HEALTH_KEYS = [
  'supabase.project',
  'supabase.rls',
  'supabase.storage',
] as const;
export type SupabaseHealthKey = (typeof SUPABASE_HEALTH_KEYS)[number];

export const SUPABASE_HEALTH_LABELS_DE: Readonly<Record<SupabaseHealthKey, string>> = {
  'supabase.project': 'Projekt erreichbar',
  'supabase.rls': 'Row Level Security',
  'supabase.storage': 'Storage-Buckets',
};

/** Default deadline for the probe. It runs on a page render, so it is short. */
export const SUPABASE_PROBE_TIMEOUT_MS = 5_000;

/**
 * The buckets `supabase/migrations/0014_storage.sql` creates. Named here because
 * the probe reports which of them are missing, and "missing" needs something to
 * be missing from.
 */
export const REQUIRED_STORAGE_BUCKETS: readonly string[] = [
  'brand-assets',
  'creative-renditions',
  'creative-source',
  'historical-creatives',
  'private-imports',
];

/** How many table or bucket names a detail line spells out before truncating. */
const MAX_NAMED_ENTRIES = 5;

/* -------------------------------------------------------------------------- */
/* The connection port                                                         */
/* -------------------------------------------------------------------------- */

export interface SqlProbeResult<Row> {
  rows: Row[];
}

/** The narrow slice of a Postgres connection this probe needs. */
export interface SqlProbeConnection {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<SqlProbeResult<Row>>;
  close(): Promise<void>;
}

export type SqlProbeConnector = (input: {
  connectionString: string;
  timeoutMs: number;
}) => Promise<SqlProbeConnection>;

interface PgClientLike {
  connect(): Promise<void>;
  query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

interface PgModule {
  Client: new (config: Record<string, unknown>) => PgClientLike;
}

/**
 * Held in a variable rather than written at the call site, so no bundler
 * statically resolves it. Everything else in this package reaches Postgres
 * through PostgREST; only this probe needs catalogue access, which PostgREST
 * does not expose, and `pg` is a devDependency here.
 */
const DRIVER_SPECIFIER = 'pg';

/**
 * Loads the driver lazily and by request rather than by import.
 *
 * An environment that cannot provide it reports that the database could not be
 * checked — which is the honest answer, and neither a connection nor a failure
 * of the database itself.
 */
function loadPg(): PgModule {
  try {
    return createRequire(import.meta.url)(DRIVER_SPECIFIER) as PgModule;
  } catch (cause) {
    throw new DomainError('PROVIDER_NOT_CONFIGURED', {
      messageDe:
        'Der Postgres-Treiber (pg) steht in dieser Umgebung nicht zur Verfügung, daher konnte die Datenbank nicht geprüft werden.',
      details: { driver: DRIVER_SPECIFIER },
      cause,
    });
  }
}

/** Opens a real connection. Replaced in tests by a connector that cannot reach a server. */
export const connectWithPg: SqlProbeConnector = async ({ connectionString, timeoutMs }) => {
  const pg = loadPg();
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: 'am-marketing-os/health',
  });
  await client.connect();
  return {
    query: async (text, values) => client.query(text, values),
    close: () => client.end(),
  };
};

/* -------------------------------------------------------------------------- */
/* Statements                                                                  */
/* -------------------------------------------------------------------------- */

const IDENTITY_SQL = `
select current_database() as database_name,
       current_user      as user_name,
       version()         as server_version;
`.trim();

/**
 * RLS coverage, read from the catalogue rather than from `information_schema`:
 * `information_schema.tables` only lists what the current role holds a privilege
 * on, so a role with fewer grants would report perfect coverage of the tables it
 * happens to see. `pg_class` shows every table either way.
 */
const RLS_COVERAGE_SQL = `
select c.relname          as table_name,
       c.relrowsecurity   as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;
`.trim();

const STORAGE_PRESENT_SQL = `select to_regclass('storage.buckets') is not null as present;`;

const STORAGE_BUCKETS_SQL = `select b.id as id from storage.buckets b order by b.id;`;

/* -------------------------------------------------------------------------- */
/* Probe                                                                       */
/* -------------------------------------------------------------------------- */

export interface SupabaseHealthOptions {
  /** Defaults to a real `pg` connection. */
  connect?: SqlProbeConnector;
  /** Defaults to `DATABASE_URL`. `null` asserts that none is configured. */
  connectionString?: string | null;
  /** Overrides the fixture/live decision from `@am/config`. */
  mode?: ProviderMode;
  timeoutMs?: number;
  now?: string;
}

interface ProbeReading {
  databaseName: string;
  serverVersion: string;
  userName: string;
  tableCount: number;
  tablesWithoutRls: string[];
  /** `null` when the instance has no `storage` schema at all. */
  buckets: string[] | null;
}

function check(
  key: SupabaseHealthKey,
  status: HealthStatus,
  detailDe: string,
  remediationDe: string | null,
  checkedAt: string,
  blocksLiveOnly = false,
): HealthCheck {
  return {
    key,
    labelDe: SUPABASE_HEALTH_LABELS_DE[key],
    status,
    detailDe,
    checkedAt,
    remediationDe,
    blocksLiveOnly,
  };
}

function nameList(values: readonly string[]): string {
  const shown = values.slice(0, MAX_NAMED_ENTRIES).join(', ');
  return values.length > MAX_NAMED_ENTRIES
    ? `${shown} und ${values.length - MAX_NAMED_ENTRIES} weitere`
    : shown;
}

/** `version()` is a paragraph; the product only needs the product and release. */
function shortVersion(serverVersion: string): string {
  const match = /^PostgreSQL\s+(\S+)/.exec(serverVersion);
  return match ? `PostgreSQL ${match[1]}` : 'unbekannte Version';
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DomainError('PROVIDER_ERROR', {
            messageDe: `Zeitüberschreitung: Die Datenbank hat innerhalb von ${Math.round(timeoutMs / 1000)} Sekunden nicht geantwortet.`,
            details: { operation, timeout_ms: timeoutMs },
            retryable: true,
          }),
        ),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function read(connection: SqlProbeConnection): Promise<ProbeReading> {
  const identity = await connection.query<{
    database_name: string;
    user_name: string;
    server_version: string;
  }>(IDENTITY_SQL);
  const row = identity.rows[0];
  if (!row) {
    throw new DomainError('PROVIDER_ERROR', {
      messageDe: 'Die Datenbank hat auf die Identitätsabfrage keine Zeile zurückgegeben.',
      details: { statement: 'identity' },
    });
  }

  const coverage = await connection.query<{ table_name: string; rls_enabled: boolean }>(
    RLS_COVERAGE_SQL,
  );

  const storagePresent = await connection.query<{ present: boolean }>(STORAGE_PRESENT_SQL);
  const buckets = storagePresent.rows[0]?.present
    ? (await connection.query<{ id: string }>(STORAGE_BUCKETS_SQL)).rows.map((entry) => entry.id)
    : null;

  return {
    databaseName: row.database_name,
    userName: row.user_name,
    serverVersion: row.server_version,
    tableCount: coverage.rows.length,
    tablesWithoutRls: coverage.rows.filter((t) => !t.rls_enabled).map((t) => t.table_name),
    buckets,
  };
}

function fixtureChecks(checkedAt: string): HealthCheck[] {
  return [
    check(
      'supabase.project',
      'AWAITING_EXTERNAL_INPUT',
      'Es besteht keine Verbindung zu einem Supabase-Projekt. Die Konsole läuft gegen den In-Memory-Datenspeicher.',
      'DEMO_MODE deaktivieren sowie NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY und DATABASE_URL hinterlegen.',
      checkedAt,
      true,
    ),
    check(
      'supabase.rls',
      'AWAITING_EXTERNAL_INPUT',
      'Ohne Projekt kann nicht geprüft werden, ob RLS aktiv ist.',
      null,
      checkedAt,
      true,
    ),
    check(
      'supabase.storage',
      'AWAITING_EXTERNAL_INPUT',
      'Ohne Projekt kann nicht geprüft werden, welche Buckets existieren.',
      null,
      checkedAt,
      true,
    ),
  ];
}

/**
 * Live, but with nothing to connect to: the console reads and writes through
 * PostgREST, which cannot answer a catalogue question. That leaves RLS coverage
 * and the bucket inventory genuinely unknown, and unknown is what gets reported.
 */
function unverifiableChecks(checkedAt: string): HealthCheck[] {
  const remediationDe =
    'DATABASE_URL des Projekts hinterlegen, damit die Konsole selbst prüfen kann.';
  return [
    check(
      'supabase.project',
      'AWAITING_EXTERNAL_INPUT',
      'Das Projekt ist als Live-Anbindung konfiguriert, es ist aber keine DATABASE_URL hinterlegt — die Verbindung lässt sich von hier aus nicht prüfen.',
      remediationDe,
      checkedAt,
      true,
    ),
    check(
      'supabase.rls',
      'AWAITING_EXTERNAL_INPUT',
      'Nicht geprüft: Ohne DATABASE_URL ist unbekannt, ob RLS auf allen Tabellen aktiv ist.',
      remediationDe,
      checkedAt,
      true,
    ),
    check(
      'supabase.storage',
      'AWAITING_EXTERNAL_INPUT',
      'Nicht geprüft: Ohne DATABASE_URL ist unbekannt, welche Buckets existieren.',
      remediationDe,
      checkedAt,
      true,
    ),
  ];
}

/** What to do about it depends on what went wrong, so the cause picks the text. */
function remediationFor(failure: DomainError): string {
  if (failure.details.driver === DRIVER_SPECIFIER) {
    return 'Den Postgres-Treiber (pg) in dieser Umgebung bereitstellen; ohne ihn kann die Konsole Schema und Buckets nicht selbst prüfen.';
  }
  return failure.code === 'PROVIDER_NOT_CONFIGURED'
    ? 'DATABASE_URL prüfen und die Zugangsdaten des Projekts hinterlegen.'
    : 'DATABASE_URL, Netzwerkzugang und den Zustand des Supabase-Projekts prüfen.';
}

function unreachableChecks(failure: DomainError, checkedAt: string): HealthCheck[] {
  const awaiting = failure.code === 'PROVIDER_NOT_CONFIGURED';
  return [
    check(
      'supabase.project',
      awaiting ? 'AWAITING_EXTERNAL_INPUT' : 'FAIL',
      `Die Datenbankverbindung kam nicht zustande: ${failure.messageDe}`,
      remediationFor(failure),
      checkedAt,
      true,
    ),
    check(
      'supabase.rls',
      'AWAITING_EXTERNAL_INPUT',
      'Nicht geprüft: Ohne Verbindung sagt nichts aus, ob RLS auf allen Tabellen aktiv ist.',
      'Zuerst die Verbindung herstellen; RLS wird dann automatisch mitgeprüft.',
      checkedAt,
      true,
    ),
    check(
      'supabase.storage',
      'AWAITING_EXTERNAL_INPUT',
      'Nicht geprüft: Ohne Verbindung sagt nichts aus, welche Buckets existieren.',
      'Zuerst die Verbindung herstellen; die Buckets werden dann automatisch mitgeprüft.',
      checkedAt,
      true,
    ),
  ];
}

function rlsCheck(reading: ProbeReading, checkedAt: string): HealthCheck {
  if (reading.tableCount === 0) {
    return check(
      'supabase.rls',
      'FAIL',
      'Im Schema „public" existiert keine einzige Tabelle. Die Migrationen sind in dieser Datenbank nicht eingespielt.',
      'Migrationen aus supabase/migrations einspielen.',
      checkedAt,
      true,
    );
  }
  if (reading.tablesWithoutRls.length > 0) {
    return check(
      'supabase.rls',
      'FAIL',
      `RLS ist auf ${reading.tablesWithoutRls.length} von ${reading.tableCount} Tabellen im Schema „public" nicht aktiv: ${nameList(reading.tablesWithoutRls)}.`,
      'Migration 0012_rls.sql erneut einspielen; sie aktiviert RLS auf jeder Tabelle.',
      checkedAt,
      true,
    );
  }
  return check(
    'supabase.rls',
    'PASS',
    `RLS ist auf allen ${reading.tableCount} Tabellen im Schema „public" aktiv.`,
    null,
    checkedAt,
    true,
  );
}

function storageCheck(reading: ProbeReading, checkedAt: string): HealthCheck {
  if (reading.buckets === null) {
    return check(
      'supabase.storage',
      'WARN',
      'Diese Datenbank kennt kein Schema „storage"; es konnte daher kein Bucket geprüft werden.',
      'Gegen das Supabase-Projekt prüfen — eine blanke Postgres-Instanz führt keine Buckets.',
      checkedAt,
      true,
    );
  }

  const missing = REQUIRED_STORAGE_BUCKETS.filter((bucket) => !reading.buckets?.includes(bucket));
  if (missing.length > 0) {
    return check(
      'supabase.storage',
      'FAIL',
      `Es fehlen ${missing.length} von ${REQUIRED_STORAGE_BUCKETS.length} erwarteten Buckets: ${nameList(missing)}.`,
      'Migration 0014_storage.sql gegen das Projekt einspielen.',
      checkedAt,
      true,
    );
  }
  return check(
    'supabase.storage',
    'PASS',
    `Alle ${REQUIRED_STORAGE_BUCKETS.length} erwarteten Buckets sind vorhanden: ${nameList(REQUIRED_STORAGE_BUCKETS)}.`,
    null,
    checkedAt,
    true,
  );
}

/**
 * Connects, reads, reports.
 *
 * `state` follows the connection, `overall` follows the findings: a database
 * that answers but is missing a bucket is reachable and broken at the same time,
 * and the screen has to be able to say both.
 */
export async function checkSupabaseHealth(
  options: SupabaseHealthOptions = {},
): Promise<ProviderHealth> {
  const checkedAt = options.now ?? nowIso();

  const report = (state: ConnectionState, checks: HealthCheck[]): ProviderHealth => ({
    provider: 'SUPABASE',
    state,
    overall: rollUpHealth(checks),
    checks,
    checkedAt,
  });

  const mode = options.mode ?? resolveProviderMode('SUPABASE');
  if (mode === 'FIXTURE') {
    return report('FIXTURE', fixtureChecks(checkedAt));
  }

  const connectionString =
    options.connectionString === undefined
      ? typeof window === 'undefined'
        ? getServerEnv().DATABASE_URL
        : null
      : options.connectionString;

  if (!connectionString) {
    return report('DEGRADED', unverifiableChecks(checkedAt));
  }

  const timeoutMs = options.timeoutMs ?? SUPABASE_PROBE_TIMEOUT_MS;
  const connect = options.connect ?? connectWithPg;

  let reading: ProbeReading;
  try {
    reading = await instrumented('SUPABASE', 'supabase.health.probe', async () => {
      const connection = await withDeadline(
        connect({ connectionString, timeoutMs }),
        timeoutMs,
        'supabase.health.connect',
      );
      try {
        return await withDeadline(read(connection), timeoutMs, 'supabase.health.read');
      } finally {
        await connection.close().catch(() => undefined);
      }
    });
  } catch (error) {
    const failure =
      error instanceof DomainError
        ? error
        : new DomainError('PROVIDER_ERROR', {
            messageDe:
              error instanceof Error
                ? error.message
                : 'Unbekannter Fehler bei der Datenbankprüfung.',
            details: { operation: 'supabase.health.probe' },
            cause: error,
          });
    // A refused or broken connection is an error about the database. A probe
    // that could not run at all — no driver here — establishes nothing about the
    // database, so it reports as limited rather than as a fault of the project.
    return report(
      failure.code === 'PROVIDER_NOT_CONFIGURED' ? 'DEGRADED' : 'ERROR',
      unreachableChecks(failure, checkedAt),
    );
  }

  const checks: HealthCheck[] = [
    check(
      'supabase.project',
      'PASS',
      `Verbindung zur Datenbank „${reading.databaseName}" als Rolle „${reading.userName}" hergestellt (${shortVersion(reading.serverVersion)}).`,
      null,
      checkedAt,
      true,
    ),
    rlsCheck(reading, checkedAt),
    storageCheck(reading, checkedAt),
  ];

  const overall = rollUpHealth(checks);
  return report(
    overall === 'PASS' ? 'CONNECTED' : overall === 'FAIL' ? 'ERROR' : 'DEGRADED',
    checks,
  );
}
