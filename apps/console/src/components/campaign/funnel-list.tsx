import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle, Badge, Button, EmptyState, Section, StatusBadge } from '@am/ui';
import { ExternalLink, PencilRuler } from 'lucide-react';
import { formatDate } from '@/lib/format';
import type { FunnelOverviewView } from '@/server/campaign-port';
import { FUNNEL_KIND_LABELS_DE } from './labels';

/**
 * The funnel variants of this campaign. Editing happens in the builders, which
 * are their own routes — this page links there and never duplicates them.
 */
export function FunnelList({ view }: { view: FunnelOverviewView }) {
  if (view.variants.length === 0) {
    return (
      <EmptyState
        title="Noch keine Funnel-Varianten."
        description="Funnel-Varianten entstehen aus dem Kampagnenvorschlag. Geben Sie zuerst die Strategie frei, damit die Varianten erzeugt werden können."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {view.mixProblemsDe.length > 0 ? (
        <Alert tone="warning">
          <AlertTitle>Der Funnel-Mix erfüllt die Vorgaben nicht</AlertTitle>
          <AlertDescription>
            <ul className="ml-4 list-disc space-y-1">
              {view.mixProblemsDe.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Section
        heading={`Funnel-Varianten (${view.variants.length})`}
        description={`Mindestens ${view.minMultiStepFormVariants} Varianten müssen mehrstufige Formulare sein, damit die Qualifizierung überhaupt getestet werden kann.`}
      >
        <ul className="flex flex-col gap-3">
          {view.variants.map((variant) => (
            <li
              key={variant.versionId}
              data-funnel-kind={variant.kind}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm font-semibold text-foreground">{variant.name}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="brand" size="sm">
                      {FUNNEL_KIND_LABELS_DE[variant.kind]}
                    </Badge>
                    <Badge tone="outline" size="sm">
                      Version {variant.version}
                    </Badge>
                    {variant.kind !== 'LANDING_PAGE' ? (
                      <Badge tone="neutral" size="sm">
                        {variant.qualificationQuestionCount} Qualifizierungsfragen
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <StatusBadge kind="funnelVersion" state={variant.state} />
              </div>

              <dl className="grid gap-2 sm:grid-cols-2">
                <Field label="Versprechen">{variant.promise}</Field>
                <Field label="Hypothese">{variant.hypothesis}</Field>
                <Field label="Begründung">{variant.rationale}</Field>
                <Field label="Veröffentlicht">
                  {variant.publishedAt
                    ? `am ${formatDate(variant.publishedAt)}`
                    : 'Noch nicht veröffentlicht — Entwürfe werden nicht ausgeliefert.'}
                </Field>
              </dl>

              <div className="flex flex-wrap gap-2">
                <Button asChild variant="secondary" size="sm">
                  <Link href={variant.builderHref}>
                    <PencilRuler aria-hidden="true" />
                    Im Builder öffnen
                  </Link>
                </Button>
                {variant.publicUrl ? (
                  <Button asChild variant="ghost" size="sm">
                    <Link href={variant.publicUrl} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden="true" />
                      Veröffentlichte Seite ansehen
                    </Link>
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Section>
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
