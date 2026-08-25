'use client';

import * as React from 'react';
import {
  METRIC_CATALOG,
  RECOMMENDATION_ACTION_LABELS_DE,
  isProviderConfirmed,
  type RecommendationFact,
} from '@am/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AttributionCoverageBadge,
  Badge,
  Button,
  ConfirmDialog,
  DataMaturityBadge,
  DryRunNotice,
  EmptyState,
  formatMetricValueDe,
  formatMoneyMinorDe,
  Section,
  StatusBadge,
} from '@am/ui';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { formatDateTime, formatNumber } from '@/lib/format';
import type { ActionResult } from '@/lib/action-result';
import type { CommandOutcome, RecommendationView } from '@/server/campaign-port';
import { ActionFeedback, useAction } from './action-feedback';

export interface RecommendationExecutionRunner {
  (input: { campaignId: string; recommendationId: string }): Promise<ActionResult<CommandOutcome>>;
}

export function RecommendationList({
  campaignId,
  views,
  canExecute,
  execute,
}: {
  campaignId: string;
  views: RecommendationView[];
  canExecute: boolean;
  execute: RecommendationExecutionRunner;
}) {
  const open = views.filter((view) => view.recommendation.state === 'OPEN');
  const decided = views.filter((view) => view.recommendation.state !== 'OPEN');

  if (views.length === 0) {
    return (
      <EmptyState
        title="Keine offenen Empfehlungen."
        description="Empfehlungen entstehen deterministisch aus den Regeln, sobald genügend Daten vorliegen. Solange keine Regel greift, gibt es hier bewusst nichts zu tun."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <Section heading={`Offene Empfehlungen (${open.length})`}>
        {open.length === 0 ? (
          <EmptyState
            size="sm"
            title="Aktuell keine offene Empfehlung."
            description="Alle Empfehlungen wurden entschieden."
          />
        ) : (
          <ul className="flex flex-col gap-4">
            {open.map((view) => (
              <li key={view.recommendation.id}>
                <RecommendationCard
                  campaignId={campaignId}
                  view={view}
                  canExecute={canExecute}
                  execute={execute}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {decided.length > 0 ? (
        <Section heading={`Bereits entschieden (${decided.length})`}>
          <ul className="flex flex-col gap-4">
            {decided.map((view) => (
              <li key={view.recommendation.id}>
                <RecommendationCard
                  campaignId={campaignId}
                  view={view}
                  canExecute={canExecute}
                  execute={execute}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/**
 * One recommendation: the facts it rests on with their numerator and
 * denominator, what it is compared against, how mature and how certain that is,
 * the risk, the Meta objects it touches, and the exact action.
 *
 * Executing opens a `ConfirmDialog` showing precisely what would be sent, and
 * nothing happens until it is confirmed. Only a **provider-confirmed** command
 * renders as done; a dry run renders as `DryRunNotice` and never as success
 * (AGENTS.md rules 2 and 3, acceptance criteria 22 and 23).
 */
export function RecommendationCard({
  campaignId,
  view,
  canExecute,
  execute,
}: {
  campaignId: string;
  view: RecommendationView;
  canExecute: boolean;
  execute: RecommendationExecutionRunner;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const action = useAction(execute);
  const rec = view.recommendation;

  const confirmedCommand =
    view.command && isProviderConfirmed(view.command) ? view.command : null;
  const settled = action.phase.kind === 'settled' ? action.phase.result : null;
  const executedNow = settled?.status === 'ok' ? settled.data : null;
  const executionConfirmed =
    confirmedCommand !== null ||
    (executedNow !== null &&
      (executedNow.state === 'PROVIDER_CONFIRMED' || executedNow.state === 'RECONCILED'));

  return (
    <article
      data-recommendation={rec.id}
      data-recommendation-action={rec.action}
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-semibold text-foreground">{rec.titleDe}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="brand" size="sm">
              {RECOMMENDATION_ACTION_LABELS_DE[rec.action]}
            </Badge>
            <Badge tone="outline" size="sm" className="font-mono">
              {rec.ruleId}
            </Badge>
            <Badge tone={rec.risk === 'HIGH' ? 'destructive' : rec.risk === 'MEDIUM' ? 'warning' : 'neutral'} size="sm">
              Risiko: {rec.risk === 'HIGH' ? 'hoch' : rec.risk === 'MEDIUM' ? 'mittel' : 'niedrig'}
            </Badge>
          </div>
        </div>
        <StatusBadge kind="recommendation" state={rec.state} />
      </header>

      <p className="text-sm leading-relaxed text-foreground">{rec.summaryDe}</p>

      <section aria-label="Fakten" className="flex flex-col gap-2">
        <h4 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Fakten
        </h4>
        <ul className="flex flex-col gap-2">
          {rec.facts.map((fact) => (
            <FactRow key={`${fact.metric}-${fact.label}`} fact={fact} />
          ))}
        </ul>
      </section>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Vergleichsbasis">
          <span data-comparison-basis="">{rec.comparisonBasisDe}</span>
        </Field>
        <Field label="Unsicherheit">{rec.uncertaintyDe}</Field>
        <Field label="Datenreife">
          <span className="inline-flex flex-wrap items-center gap-2">
            <DataMaturityBadge maturity={rec.maturity} />
            <AttributionCoverageBadge coverage={rec.attributionCoverage} />
          </span>
        </Field>
        <Field label="Risikohinweis">{rec.riskNoteDe ?? 'Kein zusätzlicher Hinweis.'}</Field>
      </dl>

      {rec.explanationDe ? (
        <Alert tone="info">
          <AlertTitle>KI-Erläuterung (keine Zahlenquelle)</AlertTitle>
          <AlertDescription>{rec.explanationDe}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Betroffene Meta-Objekte" className="flex flex-col gap-2">
        <h4 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Betroffene Meta-Objekte
        </h4>
        {rec.affectedMetaObjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Keine — diese Empfehlung verändert nichts bei Meta.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rec.affectedMetaObjects.map((object) => (
              <li
                key={object.external_id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-sm"
              >
                <Badge tone="outline" size="sm">
                  {object.level}
                </Badge>
                <span className="text-foreground">{object.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {object.external_id}
                </span>
                {object.currentDailyBudgetMinor !== null &&
                object.proposedDailyBudgetMinor !== null ? (
                  <span data-am-numeric="" className="text-xs tabular-nums text-foreground">
                    {formatMoneyMinorDe(object.currentDailyBudgetMinor, 'EUR')} →{' '}
                    {formatMoneyMinorDe(object.proposedDailyBudgetMinor, 'EUR')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="rounded-md border border-border bg-surface-sunken px-3.5 py-3">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Genaue Aktion
        </p>
        <p className="mt-1 text-sm leading-relaxed text-foreground">{view.actionSummaryDe}</p>
      </div>

      {executionConfirmed ? (
        <Alert tone="success" icon={<CheckCircle2 aria-hidden="true" />} data-execution-confirmed="">
          <AlertTitle>Von Meta bestätigt</AlertTitle>
          <AlertDescription>
            Die Änderung wurde vom Provider bestätigt
            {confirmedCommand?.confirmedAt
              ? ` am ${formatDateTime(confirmedCommand.confirmedAt)}`
              : ''}
            . Nur ein bestätigter Befehl wird hier als erledigt angezeigt.
          </AlertDescription>
        </Alert>
      ) : view.command ? (
        <Alert tone="warning" icon={<ShieldAlert aria-hidden="true" />}>
          <AlertTitle>Noch nicht vom Provider bestätigt</AlertTitle>
          <AlertDescription>
            Der Befehl steht auf <StatusBadge kind="command" state={view.command.state} size="sm" />.
            Bis zur Bestätigung durch Meta gilt die Änderung als nicht ausgeführt.
            {view.command.error ? <span className="mt-1 block">{view.command.error}</span> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {view.lastDryRun ? <DryRunNotice result={view.lastDryRun} /> : null}

      <ActionFeedback
        phase={action.phase}
        successDe="Empfehlung ausgeführt und vom Provider bestätigt."
        pendingDe="Befehl wird an Meta übermittelt …"
      />

      {rec.state === 'OPEN' ? (
        canExecute ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              data-execute-recommendation={rec.id}
              disabled={action.pending}
              onClick={() => setDialogOpen(true)}
            >
              Annehmen und ausführen
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Ihre Rolle darf Empfehlungen nicht ausführen. Zuständig ist die Rolle Marketing Lead.
          </p>
        )
      ) : null}

      <ConfirmDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={`${RECOMMENDATION_ACTION_LABELS_DE[rec.action]} ausführen`}
        description="Prüfen Sie, was genau an Meta gesendet würde. Es wird nichts ausgeführt, bevor Sie bestätigen."
        confirmPhrase="AUSFÜHREN"
        confirmLabel="An Meta senden"
        tone="destructive"
        pending={action.pending}
        preview={
          <div className="flex flex-col gap-2">
            <p className="text-sm text-foreground">{view.actionSummaryDe}</p>
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
              Nutzlast
            </p>
            <pre className="max-h-60 overflow-auto rounded-md bg-surface-sunken px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
              {JSON.stringify(view.requestPreview, null, 2)}
            </pre>
          </div>
        }
        onConfirm={async () => {
          await action.execute({ campaignId, recommendationId: rec.id });
          setDialogOpen(false);
        }}
      />
    </article>
  );
}

function FactRow({ fact }: { fact: RecommendationFact }) {
  const definition = METRIC_CATALOG[fact.metric];
  const basis =
    fact.numerator !== null && fact.denominator !== null
      ? `${formatNumber(fact.numerator)} / ${formatNumber(fact.denominator)}`
      : null;

  return (
    <li
      data-fact-metric={fact.metric}
      className="flex flex-col gap-1 rounded-md border border-border bg-surface-raised px-3.5 py-2.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-foreground">{fact.label}</span>
        <span data-am-numeric="" className="text-sm font-semibold tabular-nums text-foreground">
          {formatMetricValueDe(fact.metric, fact.value, fact.currency, 'minor')}
        </span>
        {basis ? (
          <span data-am-rate-basis="" className="text-xs tabular-nums text-muted-foreground">
            {basis}
          </span>
        ) : null}
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        Berechnung: {definition.formula}
        {fact.comparisonLabel ? (
          <>
            {' · '}
            <span data-fact-comparison="">
              {fact.comparisonLabel}:{' '}
              {formatMetricValueDe(fact.metric, fact.comparisonValue, fact.currency, 'minor')}
            </span>
          </>
        ) : null}
      </p>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}
