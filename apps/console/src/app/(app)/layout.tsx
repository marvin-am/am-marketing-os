import { redirect } from 'next/navigation';
import { getFeatureFlags } from '@am/config';
import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';
import { getSessionUser, isDemoAuth } from '@/lib/session';

/**
 * Authenticated shell. Every route under `(app)` is gated here, so no page has
 * to remember to check — an unauthenticated request lands on the sign-in screen
 * before any data access happens.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const flags = getFeatureFlags();

  return (
    <div className="flex min-h-screen flex-col">
      <Topbar
        displayName={user.displayName}
        email={user.email}
        roles={user.roles}
        flags={flags}
        demoAuth={isDemoAuth()}
        signOutHref="/logout"
      />
      <div className="flex flex-1">
        <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:block">
          <div className="sticky top-14">
            <Sidebar />
          </div>
        </aside>
        <main id="inhalt" className="min-w-0 flex-1 px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
