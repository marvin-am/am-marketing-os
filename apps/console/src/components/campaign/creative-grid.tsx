'use client';

import * as React from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  cn,
  ConfidenceBadge,
  formatPercentDe,
  Section,
  StatusBadge,
} from '@am/ui';
import { AlertTriangle, ImageOff, ShieldCheck } from 'lucide-react';
import type { ActionResult } from '@/lib/action-result';
import type { CreativeBoardView, CreativeCard } from '@/server/campaign-port';
import { ActionFeedback, useAction } from './action-feedback';
import { assetGateBlockedReasonDe } from './gates';
import { PRINCIPLE_LABELS_DE } from './labels';

export interface CreativeReviewRunner {
  (input: {
    campaignId: string;
    creativeId: string;
    decision: 'APPROVE' | 'REJECT';
    reasonDe?: string;
  }): Promise<ActionResult<CreativeBoardView>>;
}

export interface CreativeGridProps {
  board: CreativeBoardView;
  canReview: boolean;
  review: CreativeReviewRunner;
  /** Rendered under the diversity panel — the asset approval itself. */
  approvalSlot?: React.ReactNode;
}

/**
 * The six concepts, their renditions and their per-format approval, plus the
 * diversity check that gates the whole set.
 *
 * When fewer than five concepts are conceptually distinct, asset approval is
 * blocked and the offending pairs are named — a bare "not distinct enough"
 * would leave the operator with nothing to act on (spec §12).
 */
export function CreativeGrid({ board, canReview, review, approvalSlot }: CreativeGridProps) {
  const blockedReasonDe = assetGateBlockedReasonDe(board);

  return (
    <div className="flex flex-col gap-8">
      <DiversityPanel board={board} />

      {approvalSlot ? (
        <Section heading="Freigabe der Assets">
          {blockedReasonDe ? (
            <Alert tone="warning" className="mb-4" data-asset-gate-blocked="">
              <AlertTitle>Asset-Freigabe blockiert</AlertTitle>
              <AlertDescription>{blockedReasonDe}</AlertDescription>
            </Alert>
          ) : null}
          {approvalSlot}
        </Section>
      ) : null}

      <Section
        heading={`Creative-Konzepte (${board.approvedCount} von ${board.creatives.length} freigegeben)`}
        description={`Für einen Launch müssen mindestens ${board.minApproved} konzeptionell unterschiedliche Creatives freigegeben sein.`}
      >
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {board.creatives.map((creative) => (
            <CreativeConceptCard
              key={creative.id}
              campaignId={board.campaignId}
              creative={creative}
              canReview={canReview}
              review={review}
              collidesWith={board.diversity.collisions
                .filter((c) => c.aKey === creative.key || c.bKey === creative.key)
                .map((c) => (c.aKey === creative.key ? c.bName : c.aName))}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

export function DiversityPanel({ board }: { board: CreativeBoardView }) {
  const { diversity } = board;
  return (
    <Section
      heading="Diversitätsprüfung"
      description="Zwei Konzepte, die dieselbe Idee erzählen, zählen als eines. Geprüft werden Aufhänger, Anzeigentext, Bildidee, verwendeter Beleg und Funnel-Versprechen."
    >
      <div
        data-diversity-blocked={diversity.blocked ? 'true' : 'false'}
        className={cn(
          'flex flex-col gap-3 rounded-lg border-2 p-4',
          diversity.blocked
            ? 'border-warning-border bg-warning-surface'
            : 'border-success-border bg-success-surface',
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className={diversity.blocked ? 'text-warning' : 'text-success'}>
            {diversity.blocked ? (
              <AlertTriangle className="size-5" />
            ) : (
              <ShieldCheck className="size-5" />
            )}
          </span>
          <p className="text-sm font-semibold text-foreground">
            {diversity.distinctCount} von {diversity.requiredDistinct} erforderlichen Konzepten sind
            konzeptionell unterschiedlich.
          </p>
          <Badge tone={diversity.blocked ? 'warning' : 'success'}>
            {diversity.blocked ? 'Freigabe blockiert' : 'Anforderung erfüllt'}
          </Badge>
        </div>

        {diversity.reasonsDe.length > 0 ? (
          <ul className="ml-4 list-disc space-y-1 text-sm text-foreground">
            {diversity.reasonsDe.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}

        {diversity.collisions.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Zu ähnliche Paare
            </p>
            <ul className="flex flex-col gap-2">
              {diversity.collisions.map((collision) => (
                <li
                  key={`${collision.aKey}-${collision.bKey}`}
                  data-diversity-pair={`${collision.aKey}-${collision.bKey}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-surface px-3.5 py-3"
                >
                  <p className="text-sm font-medium text-foreground">
                    „{collision.aName}" und „{collision.bName}"
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="outline" size="sm">
                      Ähnlichkeit {formatPercentDe(collision.overall, 0)}
                    </Badge>
                    {collision.samePrinciple ? (
                      <Badge tone="warning" size="sm">
                        Gleiches Kommunikationsprinzip
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {collision.reasonDe}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function CreativeConceptCard({
  campaignId,
  creative,
  canReview,
  review,
  collidesWith,
}: {
  campaignId: string;
  creative: CreativeCard;
  canReview: boolean;
  review: CreativeReviewRunner;
  collidesWith: string[];
}) {
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const action = useAction(review);

  return (
    <article
      data-creative-key={creative.key}
      data-review-state={creative.reviewState}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-semibold text-foreground">{creative.concept.name}</h3>
          <Badge tone="brand" size="sm">
            {PRINCIPLE_LABELS_DE[creative.concept.principle]}
          </Badge>
        </div>
        <StatusBadge kind="assetReview" state={creative.reviewState} />
      </header>

      <div className="grid grid-cols-2 gap-2">
        {creative.renditions.map((rendition) => (
          <figure
            key={rendition.id}
            data-aspect-ratio={rendition.aspectRatio}
            className="flex flex-col gap-1"
          >
            <div
              className="flex items-center justify-center rounded-md border border-dashed border-border bg-surface-sunken text-muted-foreground"
              style={{ aspectRatio: `${rendition.widthPx} / ${rendition.heightPx}` }}
            >
              {rendition.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={rendition.previewUrl}
                  alt={rendition.altTextDe}
                  className="size-full rounded-md object-cover"
                />
              ) : (
                <span className="flex flex-col items-center gap-1 p-3 text-center text-xs">
                  <ImageOff aria-hidden="true" className="size-4" />
                  Rendition {rendition.aspectRatio} noch nicht gerendert
                </span>
              )}
            </div>
            <figcaption className="text-[0.6875rem] leading-snug text-muted-foreground">
              {rendition.aspectRatio} · {rendition.widthPx}×{rendition.heightPx} px ·{' '}
              {rendition.provenanceDe}
            </figcaption>
          </figure>
        ))}
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        <Row label="Headline">{creative.concept.copy.headline}</Row>
        <Row label="Primärtext">{creative.concept.copy.primaryText}</Row>
        <Row label="Beschreibung">{creative.concept.copy.description}</Row>
        <Row label="Call to Action">{creative.concept.copy.callToAction}</Row>
        <Row label="Hypothese">{creative.concept.hypothesis}</Row>
        <Row label="Verwendeter Beleg">
          {creative.concept.proofUsed ?? 'Kein Beleg — die Aussage ist als Hypothese zu behandeln.'}
        </Row>
        <Row label="Funnel-Versprechen">{creative.concept.funnelPromise}</Row>
      </dl>

      {creative.concept.claims.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {creative.concept.claims.map((claim) => (
            <li key={claim.text}>
              <ConfidenceBadge confidence={claim.confidence} withHint={false} />
            </li>
          ))}
        </ul>
      ) : null}

      {collidesWith.length > 0 ? (
        <Alert tone="warning">
          <AlertTitle>Zu ähnlich zu einem anderen Konzept</AlertTitle>
          <AlertDescription>
            Dieses Konzept zählt zusammen mit „{collidesWith.join('", „')}" als eine Idee.
          </AlertDescription>
        </Alert>
      ) : null}

      {creative.rejectedReasonDe ? (
        <Alert tone="destructive">
          <AlertTitle>Abgelehnt</AlertTitle>
          <AlertDescription>{creative.rejectedReasonDe}</AlertDescription>
        </Alert>
      ) : null}

      {canReview ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={action.pending || creative.reviewState === 'APPROVED'}
              loading={action.pending && !rejecting}
              onClick={() => {
                setRejecting(false);
                void action.execute({
                  campaignId,
                  creativeId: creative.id,
                  decision: 'APPROVE',
                });
              }}
            >
              {creative.reviewState === 'APPROVED' ? 'Bereits freigegeben' : 'Creative freigeben'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={action.pending}
              onClick={() => setRejecting((value) => !value)}
            >
              {rejecting ? 'Abbrechen' : 'Ablehnen'}
            </Button>
          </div>
          {rejecting ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void action.execute({
                  campaignId,
                  creativeId: creative.id,
                  decision: 'REJECT',
                  reasonDe: reason,
                });
              }}
            >
              <label
                htmlFor={`reject-${creative.key}`}
                className="text-xs font-medium text-foreground"
              >
                Begründung der Ablehnung
              </label>
              <textarea
                id={`reject-${creative.key}`}
                required
                minLength={5}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="min-h-20 rounded-md border border-border bg-surface p-2 text-sm text-foreground"
              />
              <div>
                <Button type="submit" size="sm" variant="destructive" loading={action.pending}>
                  Ablehnung speichern
                </Button>
              </div>
            </form>
          ) : null}
          <ActionFeedback
            phase={action.phase}
            successDe="Creative-Entscheidung gespeichert."
            pendingDe="Entscheidung wird gespeichert …"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Ihre Rolle darf Creatives nicht freigeben.
        </p>
      )}
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}
