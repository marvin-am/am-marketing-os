import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPublicEnv, isProviderConfigured } from '@am/config';

/**
 * Request-scoped Supabase client for server components and route handlers.
 *
 * Returns `null` — rather than throwing — when no project is configured, so the
 * console degrades to the in-memory demo store instead of erroring out. Callers
 * branch on the null explicitly; there is no silent fallback that could make a
 * demo look like a real database.
 */
export async function createServerSupabaseClient(): Promise<SupabaseClient | null> {
  if (!isProviderConfigured('SUPABASE')) {
    const env = getPublicEnv();
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
  }

  const env = getPublicEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;

  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a server component, where cookies are read-only. The
          // middleware refreshes the session instead; ignoring here is correct
          // rather than a swallowed error.
        }
      },
    },
  });
}
