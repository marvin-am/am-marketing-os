import { createRequire } from 'node:module';

/**
 * A PostgREST-shaped client over `pg`, for the console's Postgres integration
 * tests.
 *
 * `createSupabaseDatabase(client)` speaks PostgREST, and a scratch Postgres has
 * no PostgREST in front of it. Writing a second, hand-rolled SQL implementation
 * of the repositories to test against would prove nothing about the repositories
 * the product actually runs — so this translates the builder calls the
 * repositories make into the SQL they mean, and the real `AmDatabase` runs on
 * top of a real database.
 *
 * Two properties keep that honest:
 *
 *  * **It is narrow and it says so.** Only the builder surface the repositories
 *    under test use is implemented. Anything else throws, loudly, naming the
 *    call — a test must never pass because an unsupported filter was quietly
 *    dropped and the query returned more rows than it should have.
 *  * **It connects as the database owner**, exactly like the service-role client
 *    the console uses for these reads, so RLS behaves the same way. RLS itself is
 *    covered by `supabase/tests/privileges.test.ts`; this file is about the
 *    repositories.
 *
 * Type parsers are set per client rather than globally: the repositories expect
 * ISO strings for timestamps, `YYYY-MM-DD` for dates and numbers for `bigint` /
 * `numeric`, which is what PostgREST delivers over JSON.
 */

const require = createRequire(new URL('../../../packages/db/package.json', import.meta.url));

interface PgQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface PgClient {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgQueryResult<Row>>;
  end(): Promise<void>;
}

interface PgTypes {
  getTypeParser(oid: number, format?: string): (value: string) => unknown;
}

interface PgModule {
  Client: new (config: {
    connectionString: string;
    types?: { getTypeParser(oid: number, format?: string): (value: string) => unknown };
  }) => PgClient;
  types: PgTypes;
}

const pg = require('pg') as PgModule;

const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 } as const;

/** Parsers that make `pg` hand back what PostgREST's JSON would have. */
function typeParsers() {
  const timestamp = pg.types.getTypeParser(OID.TIMESTAMPTZ);
  const toIso = (value: string): unknown => {
    const parsed = timestamp(value);
    return parsed instanceof Date ? parsed.toISOString() : parsed;
  };
  const overrides: Record<number, (value: string) => unknown> = {
    [OID.INT8]: (value) => Number(value),
    [OID.NUMERIC]: (value) => Number(value),
    // A `date` column is a calendar day. Parsing it into a Date would move it
    // into the local zone and the rollup key would drift by a day.
    [OID.DATE]: (value) => value,
    [OID.TIMESTAMP]: toIso,
    [OID.TIMESTAMPTZ]: toIso,
  };
  return {
    getTypeParser(oid: number, format?: string): (value: string) => unknown {
      return overrides[oid] ?? pg.types.getTypeParser(oid, format);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Embedded resources                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The embedded selects the repositories issue.
 *
 * PostgREST resolves `leads(id,vq_status)` from the foreign key; there is no
 * catalogue lookup here, so each embed the repositories use is declared. A
 * select that names an undeclared embed throws rather than silently returning
 * rows without it.
 */
interface EmbedRelation {
  table: string;
  /** Column on the parent row. */
  parentKey: string;
  /** Column on the embedded table pointing back at the parent. */
  foreignKey: string;
  /** PostgREST returns an object for a to-one embed and an array for to-many. */
  toOne: boolean;
}

const EMBEDS: Readonly<Record<string, EmbedRelation>> = {
  // `experiments.observations()`: one lead per accepted submission.
  'form_submissions.leads': {
    table: 'leads',
    parentKey: 'id',
    foreignKey: 'submission_id',
    toOne: true,
  },
};

/* -------------------------------------------------------------------------- */
/* Query building                                                              */
/* -------------------------------------------------------------------------- */

type Filter =
  | { kind: 'cmp'; column: string; op: string; value: unknown }
  | { kind: 'in'; column: string; values: readonly unknown[] }
  | { kind: 'null'; column: string; negated: boolean }
  | { kind: 'overlaps'; column: string; values: readonly unknown[] };

interface Params {
  values: unknown[];
}

function bind(params: Params, value: unknown): string {
  params.values.push(value);
  return `$${params.values.length}`;
}

function whereClause(filters: readonly Filter[], params: Params): string {
  if (filters.length === 0) return '';
  const parts = filters.map((filter) => {
    switch (filter.kind) {
      case 'cmp':
        return `${filter.column} ${filter.op} ${bind(params, filter.value)}`;
      case 'in':
        return filter.values.length === 0
          ? 'false'
          : `${filter.column} = any(${bind(params, [...filter.values])})`;
      case 'null':
        return `${filter.column} is ${filter.negated ? 'not ' : ''}null`;
      case 'overlaps':
        return `${filter.column} && ${bind(params, [...filter.values])}`;
    }
  });
  return ` where ${parts.join(' and ')}`;
}

function unsupported(what: string): never {
  throw new Error(
    `postgrest-over-pg: ${what} is not implemented. Add it deliberately rather than letting a test pass on a dropped filter.`,
  );
}

interface Settled {
  data: unknown;
  error: { code?: string; message?: string } | null;
  count: number | null;
}

interface BuilderState {
  table: string;
  action: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  columns: string;
  wantCount: boolean;
  filters: Filter[];
  orders: Array<{ column: string; ascending: boolean }>;
  limit: number | null;
  offset: number;
  payload: unknown;
  onConflict: string | null;
  /** Set by `.single()` / `.maybeSingle()`. */
  cardinality: 'many' | 'one' | 'maybe';
}

function splitTopLevel(select: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of select) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export interface PgBackedClient {
  /** Structurally the `DbClient` the repositories take. */
  client: unknown;
  close(): Promise<void>;
}

export async function createPgDbClient(connectionString: string): Promise<PgBackedClient> {
  const connection = new pg.Client({ connectionString, types: typeParsers() });
  await connection.connect();

  const run = async (state: BuilderState): Promise<Settled> => {
    const params: Params = { values: [] };
    const table = `public.${state.table}`;

    const selection = splitTopLevel(state.columns);
    const embeds = selection
      .map((part) => /^([a-z_]+)\((.*)\)$/i.exec(part))
      .filter((match): match is RegExpExecArray => match !== null);
    const plainColumns = selection.filter((part) => !/^[a-z_]+\(.*\)$/i.test(part));

    let sql: string;
    if (state.action === 'select') {
      const columns = plainColumns.length === 0 ? '*' : plainColumns.join(', ');
      sql = `select ${columns} from ${table}${whereClause(state.filters, params)}`;
      if (state.orders.length > 0) {
        sql += ` order by ${state.orders
          .map((order) => `${order.column} ${order.ascending ? 'asc' : 'desc'}`)
          .join(', ')}`;
      }
      if (state.limit !== null) sql += ` limit ${state.limit}`;
      if (state.offset > 0) sql += ` offset ${state.offset}`;
    } else if (state.action === 'insert' || state.action === 'upsert') {
      const rows = Array.isArray(state.payload) ? state.payload : [state.payload];
      if (rows.length === 0) return { data: [], error: null, count: 0 };
      const columnNames = [
        ...new Set(rows.flatMap((row) => Object.keys(row as Record<string, unknown>))),
      ];
      const tuples = rows.map((row) => {
        const record = row as Record<string, unknown>;
        return `(${columnNames
          .map((column) =>
            column in record ? bind(params, normalize(record[column])) : 'default',
          )
          .join(', ')})`;
      });
      sql = `insert into ${table} (${columnNames.join(', ')}) values ${tuples.join(', ')}`;
      if (state.action === 'upsert') {
        const conflict = state.onConflict ?? unsupported('upsert without onConflict');
        const assignments = columnNames
          .filter((column) => !conflict.split(',').includes(column))
          .map((column) => `${column} = excluded.${column}`);
        sql +=
          assignments.length === 0
            ? ` on conflict (${conflict}) do nothing`
            : ` on conflict (${conflict}) do update set ${assignments.join(', ')}`;
      }
      sql += ' returning *';
    } else if (state.action === 'update') {
      const patch = state.payload as Record<string, unknown>;
      const assignments = Object.entries(patch)
        // `undefined` means "leave alone" in the repositories' patch objects.
        .filter(([, value]) => value !== undefined)
        .map(([column, value]) => `${column} = ${bind(params, normalize(value))}`);
      sql = `update ${table} set ${assignments.join(', ')}${whereClause(state.filters, params)} returning *`;
    } else {
      sql = `delete from ${table}${whereClause(state.filters, params)} returning *`;
    }

    let rows: Record<string, unknown>[];
    try {
      const result = await connection.query<Record<string, unknown>>(sql, params.values);
      rows = result.rows;
    } catch (error) {
      const err = error as { code?: string; message?: string; constraint?: string };
      return { data: null, error: { code: err.code, message: err.message }, count: null };
    }

    for (const [, name, columns] of embeds) {
      const relation = EMBEDS[`${state.table}.${name}`] ?? unsupported(`embed ${state.table}.${name}`);
      const keys = rows.map((row) => row[relation.parentKey]).filter((key) => key !== null);
      const embedded =
        keys.length === 0
          ? []
          : (
              await connection.query<Record<string, unknown>>(
                `select ${relation.foreignKey}, ${columns} from public.${relation.table} where ${relation.foreignKey} = any($1)`,
                [keys],
              )
            ).rows;
      const byParent = new Map<unknown, Record<string, unknown>[]>();
      for (const row of embedded) {
        const key = row[relation.foreignKey];
        const bucket = byParent.get(key);
        if (bucket) bucket.push(row);
        else byParent.set(key, [row]);
      }
      for (const row of rows) {
        const matches = byParent.get(row[relation.parentKey]) ?? [];
        row[name] = relation.toOne ? (matches[0] ?? null) : matches;
      }
    }

    let count: number | null = null;
    if (state.wantCount) {
      const countParams: Params = { values: [] };
      const countSql = `select count(*)::int as total from ${table}${whereClause(state.filters, countParams)}`;
      const result = await connection.query<{ total: number }>(countSql, countParams.values);
      count = result.rows[0]?.total ?? 0;
    }

    if (state.cardinality === 'one' && rows.length !== 1) {
      return {
        data: null,
        error: { code: 'PGRST116', message: `Expected exactly one row, got ${rows.length}.` },
        count,
      };
    }
    if (state.cardinality !== 'many') {
      return { data: rows[0] ?? null, error: null, count };
    }
    return { data: rows, error: null, count };
  };

  const makeBuilder = (state: BuilderState): Record<string, unknown> => {
    const next = (patch: Partial<BuilderState>): Record<string, unknown> =>
      makeBuilder({ ...state, ...patch });

    const builder: Record<string, unknown> = {
      then: (resolve: (value: Settled) => unknown, reject?: (reason: unknown) => unknown) =>
        run(state).then(resolve, reject),

      select: (columns?: string, options?: { count?: string }) =>
        next({ columns: columns ?? '*', wantCount: options?.count === 'exact' }),

      eq: (column: string, value: unknown) =>
        next({ filters: [...state.filters, { kind: 'cmp', column, op: '=', value }] }),
      neq: (column: string, value: unknown) =>
        next({ filters: [...state.filters, { kind: 'cmp', column, op: '<>', value }] }),
      gt: (column: string, value: unknown) =>
        next({ filters: [...state.filters, { kind: 'cmp', column, op: '>', value }] }),
      gte: (column: string, value: unknown) =>
        next({ filters: [...state.filters, { kind: 'cmp', column, op: '>=', value }] }),
      lt: (column: string, value: unknown) =>
        next({ filters: [...state.filters, { kind: 'cmp', column, op: '<', value }] }),
      lte: (column: string, value: unknown) =>
        next({ filters: [...state.filters, { kind: 'cmp', column, op: '<=', value }] }),
      in: (column: string, values: readonly unknown[]) =>
        next({ filters: [...state.filters, { kind: 'in', column, values }] }),
      is: (column: string, value: unknown) =>
        value === null
          ? next({ filters: [...state.filters, { kind: 'null', column, negated: false }] })
          : unsupported(`.is(${column}, ${String(value)})`),
      not: (column: string, op: string, value: unknown) =>
        op === 'is' && value === null
          ? next({ filters: [...state.filters, { kind: 'null', column, negated: true }] })
          : unsupported(`.not(${column}, ${op}, …)`),
      overlaps: (column: string, values: readonly unknown[]) =>
        next({ filters: [...state.filters, { kind: 'overlaps', column, values }] }),

      order: (column: string, options?: { ascending?: boolean }) =>
        next({ orders: [...state.orders, { column, ascending: options?.ascending !== false }] }),
      limit: (value: number) => next({ limit: value }),
      range: (from: number, to: number) => next({ offset: from, limit: to - from + 1 }),

      insert: (payload: unknown) => next({ action: 'insert', payload }),
      update: (payload: unknown) => next({ action: 'update', payload }),
      upsert: (payload: unknown, options?: { onConflict?: string }) =>
        next({ action: 'upsert', payload, onConflict: options?.onConflict ?? null }),
      delete: () => next({ action: 'delete' }),

      single: () => run({ ...state, cardinality: 'one' }),
      maybeSingle: () => run({ ...state, cardinality: 'maybe' }),

      ilike: (column: string) => unsupported(`.ilike(${column}, …)`),
      like: (column: string) => unsupported(`.like(${column}, …)`),
      contains: (column: string) => unsupported(`.contains(${column}, …)`),
    };
    return builder;
  };

  const client = {
    from: (table: string) =>
      makeBuilder({
        table,
        action: 'select',
        columns: '*',
        wantCount: false,
        filters: [],
        orders: [],
        limit: null,
        offset: 0,
        payload: null,
        onConflict: null,
        cardinality: 'many',
      }),

    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      const params: Params = { values: [] };
      const named = Object.entries(args)
        .map(([key, value]) => `${key} => ${bind(params, normalize(value))}`)
        .join(', ');
      try {
        const result = await connection.query<Record<string, unknown>>(
          `select * from public.${fn}(${named})`,
          params.values,
        );
        // A set-returning function of one unnamed column comes back as one key
        // per row; a scalar function returns a single row, single column.
        const rows = result.rows.map((row) => {
          const keys = Object.keys(row);
          return keys.length === 1 ? row[keys[0]] : row;
        });
        return { data: rows.length === 1 ? rows[0] : rows, error: null };
      } catch (error) {
        const err = error as { code?: string; message?: string };
        return { data: null, error: { code: err.code, message: err.message } };
      }
    },
  };

  return {
    client,
    close: () => connection.end(),
  };
}

/** JSON columns take an object; `pg` needs it serialised. */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}
