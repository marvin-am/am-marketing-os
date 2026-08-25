/**
 * A PostgREST-shaped client over a plain `pg` connection.
 *
 * `createSupabaseDatabase()` takes a `SupabaseClient`, which speaks PostgREST
 * over HTTP. A scratch Postgres has no PostgREST in front of it, so without this
 * the repository-backed `CampaignPort` could only ever be tested against the
 * in-memory store — which is the one thing a database integration test must not
 * do.
 *
 * What is faked here is the *transport*, and only the transport: the query
 * builder calls, the `{ data, error, count }` envelope and PostgREST's
 * `PGRST116` for an empty `.single()`. Everything downstream is real — the
 * repository code under test, the schema, its constraints, its triggers and its
 * RLS policies, evaluated by Postgres on the connection this is handed.
 *
 * Only the subset the repositories actually use is implemented. Anything else
 * throws by name rather than returning an empty result, so a query this cannot
 * express fails the test instead of quietly passing it.
 */

import { createRequire } from 'node:module';

/**
 * PostgREST serialises a row with Postgres' own JSON writer: `bigint` and
 * `numeric` arrive as JSON numbers, `date` as `YYYY-MM-DD`, timestamps as ISO
 * strings. node-postgres hands numerics back as strings to protect precision it
 * cannot know is safe to drop, and timestamps as `Date` objects.
 *
 * Left alone, that difference would put a string in `budget.amountMinor` and a
 * `Date` in `updatedAt` here and neither there — a divergence in the shim rather
 * than in the code under test — so the driver is told to deliver what the
 * transport it stands in for delivers.
 */
const PG_INT8 = 20;
const PG_NUMERIC = 1700;
const PG_DATE = 1082;
const PG_TIMESTAMP = 1114;
const PG_TIMESTAMPTZ = 1184;

interface PgTypesModule {
  types: { setTypeParser(oid: number, parser: (value: string) => unknown): void };
}

const pg = createRequire(new URL('../../../../packages/db/package.json', import.meta.url))(
  'pg',
) as PgTypesModule;
pg.types.setTypeParser(PG_INT8, Number);
pg.types.setTypeParser(PG_NUMERIC, Number);
pg.types.setTypeParser(PG_DATE, (value) => value);
pg.types.setTypeParser(PG_TIMESTAMP, (value) => new Date(`${value}Z`).toISOString());
pg.types.setTypeParser(PG_TIMESTAMPTZ, (value) => new Date(value).toISOString());

export interface PgConnectionLike {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export interface PostgrestError {
  code: string | null;
  message: string;
  details: string | null;
  hint: string | null;
  constraint: string | null;
}

export interface PostgrestResult {
  data: unknown;
  error: PostgrestError | null;
  count: number | null;
}

type Cardinality = 'many' | 'one' | 'maybe';

interface Filter {
  sql: string;
  values: unknown[];
}

interface InsertOptions {
  onConflict?: string;
  ignoreDuplicates?: boolean;
}

interface SelectOptions {
  count?: 'exact' | 'planned' | 'estimated';
}

function toPostgrestError(error: unknown): PostgrestError {
  const err = error as {
    code?: string;
    message?: string;
    detail?: string;
    hint?: string;
    constraint?: string;
  };
  return {
    code: err.code ?? null,
    message: err.message ?? String(error),
    details: err.detail ?? null,
    hint: err.hint ?? null,
    constraint: err.constraint ?? null,
  };
}

class Query implements PromiseLike<PostgrestResult> {
  private readonly filters: Filter[] = [];
  private readonly orders: string[] = [];
  private columns = '*';
  private limitValue: number | null = null;
  private offsetValue = 0;
  private wantCount = false;
  private cardinality: Cardinality = 'many';
  private returning = false;
  private mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Record<string, unknown>[] = [];
  private insertOptions: InsertOptions = {};

  constructor(
    private readonly connection: PgConnectionLike,
    private readonly table: string,
  ) {}

  /* ---- shape ---- */

  select(columns = '*', options: SelectOptions = {}): this {
    if (columns.includes('(')) {
      throw new Error(`Embedded selects are not supported by this shim: ${columns}`);
    }
    this.columns = columns;
    this.wantCount = options.count === 'exact';
    if (this.mode !== 'select') this.returning = true;
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.mode = 'insert';
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options: InsertOptions = {},
  ): this {
    this.mode = 'insert';
    this.payload = Array.isArray(values) ? values : [values];
    this.insertOptions = options;
    return this;
  }

  update(patch: Record<string, unknown>): this {
    this.mode = 'update';
    this.payload = [patch];
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    return this;
  }

  /* ---- filters ---- */

  eq(column: string, value: unknown): this {
    return this.push(`${quote(column)} = $?`, [value]);
  }

  neq(column: string, value: unknown): this {
    return this.push(`${quote(column)} <> $?`, [value]);
  }

  gt(column: string, value: unknown): this {
    return this.push(`${quote(column)} > $?`, [value]);
  }

  gte(column: string, value: unknown): this {
    return this.push(`${quote(column)} >= $?`, [value]);
  }

  lt(column: string, value: unknown): this {
    return this.push(`${quote(column)} < $?`, [value]);
  }

  lte(column: string, value: unknown): this {
    return this.push(`${quote(column)} <= $?`, [value]);
  }

  like(column: string, pattern: string): this {
    return this.push(`${quote(column)} like $?`, [pattern]);
  }

  ilike(column: string, pattern: string): this {
    return this.push(`${quote(column)} ilike $?`, [pattern]);
  }

  in(column: string, values: readonly unknown[]): this {
    return this.push(`${quote(column)} = any($?)`, [[...values]]);
  }

  overlaps(column: string, values: readonly unknown[]): this {
    return this.push(`${quote(column)} && $?`, [[...values]]);
  }

  is(column: string, value: null | boolean): this {
    return this.push(`${quote(column)} is ${value === null ? 'null' : String(value)}`, []);
  }

  not(column: string, operator: string, value: null | boolean): this {
    if (operator !== 'is') {
      throw new Error(`Only .not(column, 'is', …) is supported by this shim, got ${operator}`);
    }
    return this.push(`not (${quote(column)} is ${value === null ? 'null' : String(value)})`, []);
  }

  /* ---- modifiers ---- */

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orders.push(`${quote(column)} ${options.ascending === false ? 'desc' : 'asc'}`);
    return this;
  }

  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  range(from: number, to: number): this {
    this.offsetValue = from;
    this.limitValue = to - from + 1;
    return this;
  }

  single(): this {
    this.cardinality = 'one';
    return this;
  }

  maybeSingle(): this {
    this.cardinality = 'maybe';
    return this;
  }

  /* ---- execution ---- */

  then<TResult1 = PostgrestResult, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private push(fragment: string, values: unknown[]): this {
    this.filters.push({ sql: fragment, values });
    return this;
  }

  private where(params: unknown[]): string {
    if (this.filters.length === 0) return '';
    const clauses = this.filters.map((filter) => {
      let sql = filter.sql;
      for (const value of filter.values) {
        params.push(value);
        sql = sql.replace('$?', `$${params.length}`);
      }
      return sql;
    });
    return ` where ${clauses.join(' and ')}`;
  }

  private async run(): Promise<PostgrestResult> {
    try {
      const rows = await this.execute();
      const count = this.wantCount ? await this.countRows() : null;
      return this.shape(rows, count);
    } catch (error) {
      return { data: null, error: toPostgrestError(error), count: null };
    }
  }

  private shape(rows: Record<string, unknown>[], count: number | null): PostgrestResult {
    if (this.cardinality === 'many') {
      return { data: this.mode === 'select' || this.returning ? rows : null, error: null, count };
    }
    if (rows.length === 0) {
      if (this.cardinality === 'maybe') return { data: null, error: null, count };
      return {
        data: null,
        error: {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
          details: null,
          hint: null,
          constraint: null,
        },
        count,
      };
    }
    return { data: rows[0] ?? null, error: null, count };
  }

  private async execute(): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [];
    if (this.mode === 'select') {
      const where = this.where(params);
      const order = this.orders.length > 0 ? ` order by ${this.orders.join(', ')}` : '';
      const limit = this.limitValue === null ? '' : ` limit ${this.limitValue}`;
      const offset = this.offsetValue > 0 ? ` offset ${this.offsetValue}` : '';
      const text = `select ${this.columns} from public.${quote(this.table)}${where}${order}${limit}${offset}`;
      const result = await this.connection.query<Record<string, unknown>>(text, params);
      return result.rows;
    }

    if (this.mode === 'insert') {
      const columns = [...new Set(this.payload.flatMap((entry) => Object.keys(entry)))];
      const tuples = this.payload.map((entry) => {
        const placeholders = columns.map((column) => {
          params.push(entry[column] ?? null);
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      const conflict = this.conflictClause(columns);
      const text =
        `insert into public.${quote(this.table)} (${columns.map(quote).join(', ')}) ` +
        `values ${tuples.join(', ')}${conflict} returning *`;
      const result = await this.connection.query<Record<string, unknown>>(text, params);
      return result.rows;
    }

    if (this.mode === 'update') {
      const patch = this.payload[0] ?? {};
      const assignments = Object.keys(patch).map((column) => {
        params.push(patch[column] ?? null);
        return `${quote(column)} = $${params.length}`;
      });
      if (assignments.length === 0) return [];
      const where = this.where(params);
      const text = `update public.${quote(this.table)} set ${assignments.join(', ')}${where} returning *`;
      const result = await this.connection.query<Record<string, unknown>>(text, params);
      return result.rows;
    }

    const where = this.where(params);
    const result = await this.connection.query<Record<string, unknown>>(
      `delete from public.${quote(this.table)}${where} returning *`,
      params,
    );
    return result.rows;
  }

  private conflictClause(columns: readonly string[]): string {
    const target = this.insertOptions.onConflict;
    if (!target) return '';
    const keys = target.split(',').map((key) => quote(key.trim()));
    if (this.insertOptions.ignoreDuplicates) return ` on conflict (${keys.join(', ')}) do nothing`;
    const assignments = columns
      .filter((column) => !keys.includes(quote(column)))
      .map((column) => `${quote(column)} = excluded.${quote(column)}`);
    if (assignments.length === 0) return ` on conflict (${keys.join(', ')}) do nothing`;
    return ` on conflict (${keys.join(', ')}) do update set ${assignments.join(', ')}`;
  }

  private async countRows(): Promise<number> {
    const params: unknown[] = [];
    const where = this.where(params);
    const result = await this.connection.query<{ count: string }>(
      `select count(*)::text as count from public.${quote(this.table)}${where}`,
      params,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}

export interface PostgrestClientLike {
  from(table: string): Query;
  rpc(name: string, args?: Record<string, unknown>): Promise<PostgrestResult>;
}

/**
 * Wraps a connection. Every statement runs on that one connection, so a session
 * that has dropped to `authenticated` keeps its RLS context for the whole test.
 */
export function createPostgrestOverPg(connection: PgConnectionLike): PostgrestClientLike {
  return {
    from: (table: string) => new Query(connection, table),
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      const names = Object.keys(args);
      const params = names.map((key) => args[key]);
      const call = names.map((key, index) => `${quote(key)} => $${index + 1}`).join(', ');
      try {
        const result = await connection.query<Record<string, unknown>>(
          `select * from public.${quote(name)}(${call})`,
          params,
        );
        const rows = result.rows;
        // A scalar-returning function comes back as one column named after the
        // function; PostgREST unwraps that, so this does too.
        if (rows.length === 1 && rows[0] && Object.keys(rows[0]).length === 1 && name in rows[0]) {
          return { data: rows[0][name], error: null, count: null };
        }
        return { data: rows, error: null, count: null };
      } catch (error) {
        return { data: null, error: toPostgrestError(error), count: null };
      }
    },
  };
}

/**
 * Identifiers come from repository source, never from user input, but they are
 * interpolated rather than bound, so they are validated instead of trusted.
 */
function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Refusing to interpolate an unexpected identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
