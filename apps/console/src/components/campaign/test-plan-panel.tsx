import { EXPERIMENT_KIND_LABELS_DE, METRIC_CATALOG } from '@am/domain';
import { Badge, formatMoneyMinorDe, Section } from '@am/ui';
import { CircleStop, TrendingUp } from 'lucide-react';
import type { TestPlanView } from '@/server/campaign-port';

/**
 * The test plan exactly as it will be judged later: one variable, a named
 * control, the metrics that decide, the volume and runtime that make a decision
 * legitimate, and the rules that stop or scale it.
 */
export function TestPlanPanel({ view }: { view: TestPlanView }) {
  const { plan, budget } = view;
  const armLabel = (key: string) => view.armLabelsDe[key] ?? key;

  return (
    <div className="flex flex-col gap-8">
      <Section heading="Hypothese und Testvariable" bordered>
        <div className="flex flex-col gap-3">
          <Badge tone="brand">{EXPERIMENT_KIND_LABELS_DE[plan.kind]}</Badge>
          <Field label="Hypothese">{plan.hypothesis}</Field>
          <Field label="Testvariable">{plan.testVariable}</Field>
          {plan.eligibilityChanging ? (
            <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-foreground">
              Die Eignungsfragen ändern sich während der Laufzeit. Die Arme sind dadurch nicht
              vergleichbar — es darf kein Gewinner ausgerufen werden.
            </p>
          ) : null}
        </div>
      </Section>

      <Section heading="Arme" bordered>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="Kontrolle">{armLabel(plan.controlKey)}</Field>
          <Field label="Varianten">
            <ul className="ml-4 list-disc space-y-1">
              {plan.variantKeys.map((key) => (
                <li key={key}>{armLabel(key)}</li>
              ))}
            </ul>
          </Field>
        </dl>
      </Section>

      <Section heading="Metriken" bordered>
        <div className="flex flex-col gap-4">
          <MetricGroup
            label="Primärmetrik"
            tone="brand"
            keys={[plan.primaryMetric]}
          />
          <MetricGroup label="Sekundärmetriken" tone="neutral" keys={plan.secondaryMetrics} />
          <MetricGroup label="Guardrail-Metriken" tone="warning" keys={plan.guardrailMetrics} />
        </div>
      </Section>

      <Section heading="Volumen, Laufzeit und Datenreife" bordered>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Mindestvolumen je Arm">
            {plan.minSessionsPerArm} Sessions und {plan.minConversionsPerArm} Conversions
          </Field>
          <Field label="Laufzeit">
            mindestens {plan.minRuntimeDays} Tage, höchstens {plan.maxRuntimeDays} Tage
          </Field>
          <Field label="CRM-Reifefenster">
            {plan.crmMaturityDays} Tage, bevor CRM-Ergebnisse dieser Kohorte als belastbar gelten
          </Field>
        </dl>
      </Section>

      <Section heading="Stop- und Skalierungsregeln">
        <div className="grid gap-4 lg:grid-cols-2">
          <RuleList
            label="Stop-Regeln"
            tone="destructive"
            icon={<CircleStop aria-hidden="true" className="size-4 shrink-0" />}
            rules={plan.stopRules}
          />
          <RuleList
            label="Skalierungsregeln"
            tone="success"
            icon={<TrendingUp aria-hidden="true" className="size-4 shrink-0" />}
            rules={plan.scaleRules}
          />
        </div>
      </Section>

      <Section heading="Budget" bordered>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Tagesbudget">
            {formatMoneyMinorDe(budget.dailyBudgetMinor, budget.currency)}
          </Field>
          <Field label="Testbudget gesamt">
            {formatMoneyMinorDe(budget.testBudgetMinor, budget.currency)}
          </Field>
          <Field label="Ziel-CPL">
            {budget.targetCplMinor === null
              ? 'nicht gesetzt'
              : formatMoneyMinorDe(budget.targetCplMinor, budget.currency)}
          </Field>
          <Field label="Ziel je qualifiziertem VQ">
            {budget.targetCostPerQualifiedVqMinor === null
              ? 'nicht gesetzt'
              : formatMoneyMinorDe(budget.targetCostPerQualifiedVqMinor, budget.currency)}
          </Field>
        </dl>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{budget.rationale}</p>
      </Section>
    </div>
  );
}

function MetricGroup({
  label,
  tone,
  keys,
}: {
  label: string;
  tone: 'brand' | 'neutral' | 'warning';
  keys: readonly (keyof typeof METRIC_CATALOG)[];
}) {
  if (keys.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="text-sm text-muted-foreground">Keine hinterlegt.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <ul className="flex flex-col gap-1.5">
        {keys.map((key) => {
          const definition = METRIC_CATALOG[key];
          return (
            <li key={key} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={tone} size="sm">
                {definition.label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Berechnung: {definition.formula}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RuleList({
  label,
  tone,
  icon,
  rules,
}: {
  label: string;
  tone: 'destructive' | 'success';
  icon: React.ReactNode;
  rules: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <ul className="flex flex-col gap-2">
        {rules.map((rule) => (
          <li
            key={rule}
            className={
              tone === 'destructive'
                ? 'flex items-start gap-2 rounded-lg border border-destructive-border bg-destructive-surface px-3.5 py-2.5 text-sm text-foreground'
                : 'flex items-start gap-2 rounded-lg border border-success-border bg-success-surface px-3.5 py-2.5 text-sm text-foreground'
            }
          >
            <span className={tone === 'destructive' ? 'mt-0.5 text-destructive' : 'mt-0.5 text-success'}>
              {icon}
            </span>
            <span>{rule}</span>
          </li>
        ))}
      </ul>
    </div>
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
