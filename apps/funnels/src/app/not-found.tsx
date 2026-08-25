import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Seite nicht gefunden',
  robots: { index: false, follow: false },
};

/**
 * The honest 404.
 *
 * An unpublished, archived or mistyped funnel lands here. It says what happened
 * in German, offers nothing it cannot deliver — there is no "back to homepage"
 * link, because this deployment serves funnel pages and nothing else — and never
 * shows a stack trace.
 */
export default function NotFound() {
  return (
    <main className="mx-auto grid w-full max-w-xl min-w-0 gap-3 px-4 py-16">
      <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground">
        Diese Seite ist nicht verfügbar
      </h1>
      <p className="break-words text-base leading-relaxed text-muted-foreground">
        Die Kampagne wurde beendet oder der Link ist nicht mehr gültig. Wenn Sie über eine Anzeige
        hierher gekommen sind, melden Sie sich gerne direkt bei uns.
      </p>
    </main>
  );
}
