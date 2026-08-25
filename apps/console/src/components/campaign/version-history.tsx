'use client';

// `buildDiffEntries` lives in the `'use client'` diff-list module, so calling it
// from a server component would fail at render time even though it type-checks.
// The whole section renders `DiffList` anyway, so this panel is client-side.
import { AUDIT_ACTION_LABELS_DE } from '@am/domain';
import { Badge, buildDiffEntries, DiffList, EmptyState, Section } from '@am/ui';
import { formatDateTime } from '@/lib/format';
import type { HistoryView } from '@/server/campaign-port';

/**
 * Version history and audit log with before/after diffs.
 *
 * Published versions are immutable, so history always points at what was
 * actually delivered rather than at what the current draft happens to say
 * (AGENTS.md rule 6).
 */
const DIFF_LABELS_DE: Readonly<Record<string, string>> = {
  claim: 'Claim',
  dailyBudgetMinor: 'Tagesbudget (Minor Units)',
  funnelVariants: 'Anzahl Funnel-Varianten',
  state: 'Status',
  approved: 'Freigegebene Creatives',
  checks: 'Geprüfte Punkte',
  name: 'Name',
  kind: 'Art',
  status: 'Status',
  count: 'Anzahl',
  creativeConcepts: 'Creative-Konzepte',
  funnelProposals: 'Funnel-Vorschläge',
  result: 'Ergebnis',
};

export function VersionHistory({ view }: { view: HistoryView }) {
  return (
    <div className="flex flex-col gap-8">
      <Section
        heading={`Versionen (${view.versions.length})`}
        description="Veröffentlichte Versionen sind unveränderlich. Eine Änderung erzeugt eine neue Version."
      >
        {view.versions.length === 0 ? (
          <EmptyState
            size="sm"
            title="Noch keine Version veröffentlicht."
            description="Sobald die erste Version veröffentlicht wird, erscheint sie hier mit ihrem vollständigen Unterschied zur vorherigen."
          />
        ) : (
          <ul className="flex flex-col gap-4">
            {view.versions.map((version) => (
              <li
                key={version.versionId}
                data-version={version.version}
                className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{version.labelDe}</h3>
                  {version.current ? <Badge tone="success">Aktuell</Badge> : null}
                  <Badge tone="outline" size="sm">
                    {version.publishedAt
                      ? `Veröffentlicht am ${formatDateTime(version.publishedAt)}`
                      : 'Nicht veröffentlicht'}
                  </Badge>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">{version.summaryDe}</p>
                <DiffList entries={buildDiffEntries(version.before, version.after, DIFF_LABELS_DE)} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        heading={`Audit-Log (${view.auditLog.length})`}
        description="Jede Änderung mit Akteur, Zeitpunkt und redigierter Nutzlast. Personenbezogene Daten werden vor dem Schreiben entfernt."
      >
        {view.auditLog.length === 0 ? (
          <EmptyState size="sm" title="Noch keine Audit-Einträge." />
        ) : (
          <ol className="flex flex-col gap-3">
            {view.auditLog.map((entry) => (
              <li
                key={entry.id}
                data-audit-action={entry.action}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral" size="sm">
                    {AUDIT_ACTION_LABELS_DE[entry.action] ?? entry.action}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(entry.occurred_at)} · {entry.actor_label}
                  </span>
                </div>
                <p className="text-sm text-foreground">{entry.summaryDe}</p>
                {entry.before !== null || entry.after !== null ? (
                  <DiffList entries={buildDiffEntries(entry.before, entry.after, DIFF_LABELS_DE)} />
                ) : null}
                {entry.correlation_id ? (
                  <p className="font-mono text-[0.6875rem] text-muted-foreground">
                    Korrelation: {entry.correlation_id}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
