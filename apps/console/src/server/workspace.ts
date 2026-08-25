import { asId } from '@am/domain';
import type { AmDatabase, Uuid } from '@am/db';

/**
 * The workspace the console reads and writes.
 *
 * v1 is deliberately single-tenant (AGENTS.md), but every table still carries
 * `workspace_id` so the isolation is mechanical rather than assumed.
 *
 * The id is resolved from the slug rather than hard-coded, because a hard-coded
 * id that does not match the row in the database produces the worst possible
 * failure: every screen renders, every query succeeds, and every number is zero,
 * with nothing on the page to say why. The slug is stable; the uuid is whatever
 * the workspace was created with.
 */
export const CONSOLE_WORKSPACE_SLUG = 'am';

/**
 * Fallback while no workspace row exists — the id the demo session and the job
 * runtime use. Reads against it return nothing, which is the correct answer for
 * a database that has not been seeded.
 */
export const CONSOLE_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Resolves the workspace id once per port instance.
 *
 * Memoised on the returned function: a page render issues several reads and they
 * must all address the same workspace, and re-resolving per read would add a
 * round trip to each one.
 */
export function workspaceResolver(db: AmDatabase, fallback: string): () => Promise<Uuid> {
  let resolved: Promise<Uuid> | null = null;
  return () => {
    resolved ??= (async () => {
      const workspace = await db.settings.getWorkspaceBySlug(CONSOLE_WORKSPACE_SLUG);
      return asId<Uuid>(workspace?.id ?? fallback);
    })();
    return resolved;
  };
}
