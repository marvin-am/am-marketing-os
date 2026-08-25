import type { DbClient } from '@am/db';

/**
 * A PostgREST-shaped client over a raw Postgres connection.
 *
 * `@am/db`'s repositories speak `supabase-js`, and `supabase-js` speaks HTTP to
 * PostgREST. There is no PostgREST in front of the scratch database the test
 * harness provisions, so without this shim the only way to exercise the funnel
 * store against real Postgres would be to reimplement it — which would test a
 * copy rather than the code that ships.
 *
 * What this therefore does and does not prove. It proves the real repository
 * methods, the real SQL functions, the real constraints and the real
 * transaction boundaries. It does not prove PostgREST itself: RLS as PostgREST
 * applies it, its representation headers, its own error codes, or its
 * serialisation of exotic types. Those belong to `supabase/tests`, which drives
 * the roles directly.
 *
 * Deliberately narrow — it implements exactly the surface the funnel runtime's
 * repositories use, and throws rather than guessing at anything else, so a shim
 * that has quietly fallen behind fails loudly instead of passing a test that
 * proves nothing.
 */

export interface PgQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

/** Postgres type OIDs whose `pg` representation differs from PostgREST's JSON. */
const NUMERIC_OID = 1700;
const INT8_OID = 20;

interface FieldDescription {
  name: string;
  dataTypeID: number;
}

/**
 * Makes a `pg` result look like the JSON PostgREST would have sent.
 *
 * This is not cosmetic. `pg` hands back a `Date` for every `timestamptz` and a
 * string for every `numeric`, while the repositories' row types — and the domain
 * schemas the funnel store feeds them into — are written against JSON, where
 * both are already the right shape. Skipping this step would test the store
 * against data no deployment ever produces, and the first thing it would
 * "discover" is a bug that only exists in the harness.
 */
function normalizeRows<Row>(result: PgQueryResult<Row>): Row[] {
  const fields = (result as { fields?: FieldDescription[] }).fields ?? [];
  const numericColumns = new Set(
    fields
      .filter((field) => field.dataTypeID === NUMERIC_OID || field.dataTypeID === INT8_OID)
      .map((field) => field.name),
  );

  return result.rows.map((row) => {
    if (typeof row !== 'object' || row === null) return row;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (value instanceof Date) out[key] = value.toISOString();
      else if (numericColumns.has(key) && typeof value === 'string') out[key] = Number(value);
      else out[key] = value;
    }
    return out as Row;
  });
}

export type PgExecutor = <Row = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<PgQueryResult<Row>>;

interface Outcome<T> {
  data: T;
  error: unknown;
  count?: number | null;
}

type Filter = { column: string; operator: string; value: unknown };
type Ordering = { column: string; ascending: boolean };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `pg` renders a JavaScript array as a Postgres array literal, which is right
 * for `text[]` and wrong for `jsonb`. Only structured values bound to a `jsonb`
 * parameter need the explicit cast, and on the funnel path those are exactly the
 * RPC payloads.
 */
function rpcArgument(value: unknown, index: number): { placeholder: string; value: unknown } {
  if (isPlainObject(value) || Array.isArray(value)) {
    return { placeholder: `$${index}::jsonb`, value: JSON.stringify(value) };
  }
  return { placeholder: `$${index}`, value };
}

class PgRestQuery<Row> implements PromiseLike<Outcome<Row[]>> {
  private filters: Filter[] = [];
  private orderings: Ordering[] = [];
  private limitValue: number | null = null;
  private offsetValue = 0;
  private wantsCount = false;

  constructor(
    private readonly exec: PgExecutor,
    private readonly table: string,
    private readonly mode: 'select' | 'insert' | 'update',
    private readonly payload: Record<string, unknown> | null,
  ) {}

  select(_columns?: string, options?: { count?: 'exact' }): this {
    this.wantsCount = options?.count === 'exact';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, operator: '=', value });
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push({ column, operator: 'in', value: values });
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push({ column, operator: 'is', value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push({ column, operator: '<', value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ column, operator: '>=', value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ column, operator: '<=', value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderings.push({ column, ascending: options?.ascending !== false });
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

  async maybeSingle(): Promise<Outcome<Row | null>> {
    const result = await this.run();
    if (result.error) return { data: null, error: result.error };
    if (result.data.length > 1) {
      return {
        data: null,
        error: { code: 'PGRST116', message: 'Mehr als eine Zeile für maybeSingle().' },
      };
    }
    return { data: result.data[0] ?? null, error: null };
  }

  async single(): Promise<Outcome<Row | null>> {
    const result = await this.run();
    if (result.error) return { data: null, error: result.error };
    if (result.data.length !== 1) {
      return {
        data: null,
        error: { code: 'PGRST116', message: 'Genau eine Zeile erwartet.' },
      };
    }
    return { data: result.data[0] as Row, error: null };
  }

  then<TResult1 = Outcome<Row[]>, TResult2 = never>(
    onfulfilled?: ((value: Outcome<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private where(values: unknown[]): string {
    if (this.filters.length === 0) return '';
    const clauses = this.filters.map((filter) => {
      if (filter.operator === 'in') {
        const list = filter.value as readonly unknown[];
        if (list.length === 0) return 'false';
        const placeholders = list.map((entry) => {
          values.push(entry);
          return `$${values.length}`;
        });
        return `"${filter.column}" in (${placeholders.join(', ')})`;
      }
      if (filter.operator === 'is') {
        if (filter.value === null) return `"${filter.column}" is null`;
        values.push(filter.value);
        return `"${filter.column}" is not distinct from $${values.length}`;
      }
      values.push(filter.value);
      return `"${filter.column}" ${filter.operator} $${values.length}`;
    });
    return ` where ${clauses.join(' and ')}`;
  }

  private tail(): string {
    const order =
      this.orderings.length > 0
        ? ` order by ${this.orderings
            .map((entry) => `"${entry.column}" ${entry.ascending ? 'asc' : 'desc'}`)
            .join(', ')}`
        : '';
    const limit = this.limitValue === null ? '' : ` limit ${this.limitValue}`;
    const offset = this.offsetValue > 0 ? ` offset ${this.offsetValue}` : '';
    return `${order}${limit}${offset}`;
  }

  private async run(): Promise<Outcome<Row[]>> {
    const values: unknown[] = [];
    let text: string;

    if (this.mode === 'select') {
      text = `select * from public."${this.table}"${this.where(values)}${this.tail()}`;
    } else if (this.mode === 'insert') {
      const entries = Object.entries(this.payload ?? {}).filter(([, value]) => value !== undefined);
      const columns = entries.map(([column]) => `"${column}"`).join(', ');
      const placeholders = entries
        .map(([, value]) => {
          values.push(value);
          return `$${values.length}`;
        })
        .join(', ');
      text = `insert into public."${this.table}" (${columns}) values (${placeholders}) returning *`;
    } else {
      const entries = Object.entries(this.payload ?? {}).filter(([, value]) => value !== undefined);
      const assignments = entries
        .map(([column, value]) => {
          values.push(value);
          return `"${column}" = $${values.length}`;
        })
        .join(', ');
      text = `update public."${this.table}" set ${assignments}${this.where(values)} returning *`;
    }

    try {
      const result = await this.exec<Row>(text, values);
      let count: number | null = null;
      if (this.wantsCount && this.mode === 'select') {
        const counted = new PgRestQuery<{ total: string }>(this.exec, this.table, 'select', null);
        counted.filters = this.filters;
        const totals: unknown[] = [];
        const totalResult = await this.exec<{ total: string }>(
          `select count(*)::text as total from public."${this.table}"${counted.where(totals)}`,
          totals,
        );
        count = Number(totalResult.rows[0]?.total ?? 0);
      }
      return { data: normalizeRows(result), error: null, count };
    } catch (error) {
      return { data: [], error };
    }
  }
}

export function createPgRestClient(exec: PgExecutor): DbClient {
  const client = {
    from(table: string) {
      return {
        select: (columns?: string, options?: { count?: 'exact' }) =>
          new PgRestQuery(exec, table, 'select', null).select(columns, options),
        insert: (payload: Record<string, unknown>) => {
          if (Array.isArray(payload)) {
            throw new Error('Bulk insert is not part of the funnel runtime surface.');
          }
          return new PgRestQuery(exec, table, 'insert', payload);
        },
        update: (payload: Record<string, unknown>) => new PgRestQuery(exec, table, 'update', payload),
        upsert: () => {
          throw new Error('upsert is not part of the funnel runtime surface.');
        },
        delete: () => {
          throw new Error('delete is not part of the funnel runtime surface.');
        },
      };
    },

    async rpc(name: string, args: Record<string, unknown> = {}) {
      const values: unknown[] = [];
      const named = Object.entries(args).map(([key, value]) => {
        const argument = rpcArgument(value, values.length + 1);
        values.push(argument.value);
        return `${key} => ${argument.placeholder}`;
      });

      try {
        const result = await exec<{ data: unknown }>(
          `select public.${name}(${named.join(', ')}) as data`,
          values,
        );
        return { data: result.rows[0]?.data ?? null, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };

  return client as unknown as DbClient;
}
