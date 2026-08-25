import { OFFER_TYPE_LABELS_DE } from '@am/domain';
import {
  Badge,
  ConfidenceBadge,
  formatPercentDe,
  Section,
} from '@am/ui';
import { AlertTriangle, BookOpenCheck } from 'lucide-react';
import { formatDate } from '@/lib/format';
import type { StrategyView } from '@/server/campaign-port';
import { HYPOTHESIS_NOTICE_DE } from './labels';

/**
 * Everything the strategy approval actually covers, on one page: the angle, the
 * offer, the audience, the core message, the hypothesis, every claim with its
 * evidence *or* its hypothesis label, the risks, and the historical campaigns
 * this one had to differentiate itself from.
 */
export function StrategyPanel({ view }: { view: StrategyView }) {
  return (
    <div className="flex flex-col gap-8">
      <Section heading="Angle" bordered>
        <div className="flex flex-col gap-3">
          <p className="text-base font-medium text-foreground">{view.angleName}</p>
          <Field label="Perspektive">{view.anglePerspective}</Field>
          <Field label="Begründung">{view.angleRationale}</Field>
        </div>
      </Section>

      <Section heading="Offer" bordered>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-medium text-foreground">{view.offer.name}</p>
            <Badge tone="brand">{OFFER_TYPE_LABELS_DE[view.offer.type]}</Badge>
            {view.offer.effortPromise ? (
              <Badge tone="outline">Aufwand: {view.offer.effortPromise}</Badge>
            ) : null}
          </div>
          <Field label="Gegenwert für die Zielgruppe">{view.offer.valueExchange}</Field>
          <Field label="Was geliefert wird">{view.offer.deliverable}</Field>
          <Field label="Qualifizierungsabsicht">{view.offer.qualificationIntent}</Field>
        </div>
      </Section>

      <Section heading="Zielgruppe" bordered>
        <div className="flex flex-col gap-3">
          <p className="text-base font-medium text-foreground">{view.audience.name}</p>
          <Field label="Beschreibung">{view.audience.description}</Field>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="outline">{view.audience.geo}</Badge>
            {view.audience.companySizeRange ? (
              <Badge tone="outline">{view.audience.companySizeRange}</Badge>
            ) : null}
            {view.audience.industries.map((industry) => (
              <Badge key={industry} tone="neutral">
                {industry}
              </Badge>
            ))}
          </div>
          <Field label="Schmerzpunkte">
            <ul className="ml-4 list-disc space-y-1">
              {view.audience.painPoints.map((pain) => (
                <li key={pain}>{pain}</li>
              ))}
            </ul>
          </Field>
          {view.audience.exclusions.length > 0 ? (
            <Field label="Ausschlüsse">
              <ul className="ml-4 list-disc space-y-1">
                {view.audience.exclusions.map((exclusion) => (
                  <li key={exclusion}>{exclusion}</li>
                ))}
              </ul>
            </Field>
          ) : null}
        </div>
      </Section>

      <Section heading="Kernbotschaft und Hypothese" bordered>
        <div className="flex flex-col gap-3">
          <Field label="Kernbotschaft">{view.coreMessage}</Field>
          <Field label="Hypothese der Kampagne">{view.hypothesis}</Field>
        </div>
      </Section>

      <Section
        heading="Claims"
        description="Jeder Claim trägt entweder eine Evidence-Referenz oder die Kennzeichnung als Hypothese. Ohne eines von beidem darf er nicht ausgespielt werden."
      >
        <ul className="flex flex-col gap-3">
          {view.claims.map((claim) => (
            <li
              key={claim.text}
              data-claim-confidence={claim.confidence}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 text-sm font-medium text-foreground">{claim.text}</p>
                <ConfidenceBadge confidence={claim.confidence} withHint={false} />
              </div>
              {claim.evidence ? (
                <p className="inline-flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <BookOpenCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    <span className="font-medium text-foreground">Beleg:</span>{' '}
                    {claim.evidence.summary}
                    {claim.evidence.sourceRef ? (
                      <span className="ml-1 font-mono opacity-80">({claim.evidence.sourceRef})</span>
                    ) : null}
                  </span>
                </p>
              ) : (
                <p className="inline-flex items-start gap-2 text-xs leading-relaxed text-warning">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>{HYPOTHESIS_NOTICE_DE}</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section heading="Belege aus der Historie">
        <ul className="flex flex-col gap-2">
          {view.historicalEvidence.map((evidence) => (
            <li
              key={evidence.summary}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm"
            >
              <Badge tone="neutral" size="sm">
                {evidence.kind}
              </Badge>
              <span className="text-foreground">{evidence.summary}</span>
              {evidence.sourceRef ? (
                <span className="font-mono text-xs text-muted-foreground">{evidence.sourceRef}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        heading="Risiken"
        description="Benannte Risiken dieser Kampagne. Sie sind Teil der Freigabeentscheidung."
      >
        <ul className="flex flex-col gap-2">
          {view.risks.map((risk) => (
            <li
              key={risk}
              className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-sm text-foreground"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{risk}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        heading="Ähnliche Kampagnen aus der Historie"
        description="Ohne benannte Differenzierung ist eine ähnliche Kampagne eine Wiederholung, kein Test."
      >
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {view.similarPastCampaigns.map((similar) => (
              <li
                key={similar.campaignId}
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{similar.campaignName}</span>
                  <Badge tone="outline" size="sm">
                    Ähnlichkeit {formatPercentDe(similar.similarity, 0)}
                  </Badge>
                  {similar.attributionLevel ? (
                    <Badge tone="neutral" size="sm">
                      Attribution: {similar.attributionLevel}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {similar.ranAt ? `Gelaufen ab ${formatDate(similar.ranAt)}. ` : ''}
                  {similar.outcomeSummary ?? 'Kein Ergebnis hinterlegt.'}
                </p>
              </li>
            ))}
          </ul>
          <div className="rounded-lg border border-info-border bg-info-surface px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-info">
              Abgrenzung zu diesen Kampagnen
            </p>
            <p className="mt-1 text-sm leading-relaxed text-foreground">
              {view.differentiationFromPast}
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="text-sm leading-relaxed text-foreground">{children}</div>
    </div>
  );
}
