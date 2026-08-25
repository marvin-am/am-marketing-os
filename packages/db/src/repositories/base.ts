/**
 * Shared plumbing for the Supabase-backed repositories.
 */
import type { DbClient } from '../client';
import { toDomainError, unwrapList, unwrapMaybe } from '../errors';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type Page, type PageParams } from '../types';

export function normalizePage(params: PageParams | undefined): { limit: number; offset: number } {
  const limit = Math.min(Math.max(params?.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  const offset = Math.max(params?.offset ?? 0, 0);
  return { limit, offset };
}

export function toPage<T>(rows: T[], total: number | null, limit: number, offset: number): Page<T> {
  return {
    rows,
    total,
    limit,
    offset,
    hasMore: total === null ? rows.length === limit : offset + rows.length < total,
  };
}

/**
 * Groups children by a parent key. Every batched loader returns a `Map` built
 * with this, so a list view fetches children once instead of once per row.
 */
export function groupBy<T, K extends string>(rows: readonly T[], key: (row: T) => K | null): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

export function indexBy<T, K extends string>(rows: readonly T[], key: (row: T) => K | null): Map<K, T> {
  const map = new Map<K, T>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    if (!map.has(k)) map.set(k, row);
  }
  return map;
}

/** Deduplicates and drops empties before an `.in()` filter. */
export function uniqueIds(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** Base class: holds the client and offers the four unwrapping shortcuts. */
export abstract class SupabaseRepository {
  constructor(protected readonly client: DbClient) {}

  protected async selectList<T>(
    builder: PromiseLike<{ data: unknown; error: unknown }>,
    context: string,
  ): Promise<T[]> {
    const result = (await builder) as { data: T[] | null; error: null | { code?: string } };
    return unwrapList(result, context);
  }

  protected async selectMaybe<T>(
    builder: PromiseLike<{ data: unknown; error: unknown }>,
    context: string,
  ): Promise<T | null> {
    const result = (await builder) as { data: T | null; error: null | { code?: string } };
    return unwrapMaybe(result, context);
  }

  protected async selectCounted<T>(
    builder: PromiseLike<{ data: unknown; error: unknown; count?: number | null }>,
    context: string,
    limit: number,
    offset: number,
  ): Promise<Page<T>> {
    const result = (await builder) as {
      data: T[] | null;
      error: null | { code?: string };
      count?: number | null;
    };
    if (result.error) throw toDomainError(result.error, context);
    return toPage(result.data ?? [], result.count ?? null, limit, offset);
  }
}
