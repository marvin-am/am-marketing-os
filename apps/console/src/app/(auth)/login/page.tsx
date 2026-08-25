import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { getAuthCapabilities } from './actions';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Anmelden' };

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect('/heute');

  const capabilities = await getAuthCapabilities();

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-12">
      <div className="w-full max-w-md">
        <div className="pb-8 text-center">
          <p className="text-xl font-semibold tracking-tight">
            A&amp;M <span className="text-brand">Marketing OS</span>
          </p>
          <p className="pt-1 text-sm text-muted-foreground">
            Internes Werkzeug. Zugang nur für freigegebene Adressen.
          </p>
        </div>
        <LoginForm
          demo={capabilities.demo}
          supabase={capabilities.supabase}
          allowlistHint={capabilities.allowlistHint}
        />
      </div>
    </main>
  );
}
