'use client';

import { PAGE_BLOCK_LABELS_DE, type PageBlock } from '@am/funnel-schema';
import { CONFIDENCE_LABELS_DE } from '@am/domain';
import { Alert, AlertDescription, AlertTitle, Badge, Button } from '@am/ui';
import type { PageDocumentSpec } from '../port';
import { FormPreview } from './form-preview';
import { ViewportFrame } from './viewport-frame';

/**
 * Renders a landing page or a hybrid funnel the way the public runtime would.
 *
 * Blocks are rendered from the typed spec, never from stored markup — the same
 * constraint that makes an AI-authored page safe to publish also makes this
 * preview a faithful stand-in. For a hybrid funnel the embedded form is rendered
 * with the very same interactive `FormPreview`, so "page plus form" can be
 * reviewed as one flow instead of two screens.
 */

export interface PagePreviewProps {
  spec: PageDocumentSpec;
  noteDe?: string;
  className?: string;
}

export function PagePreview({ spec, noteDe, className }: PagePreviewProps) {
  const embeddedForm = spec.kind === 'HYBRID' ? spec.formSpec : null;
  const anchorBlockId = spec.kind === 'HYBRID' ? spec.form.anchorBlockId : null;

  return (
    <div className={className}>
      <ViewportFrame noteDe={noteDe}>
        <div className="flex flex-col gap-6">
          {spec.blocks.map((block) => (
            <div key={block.blockId} className="flex flex-col gap-6">
              <BlockPreview block={block} />
              {spec.kind === 'HYBRID' && anchorBlockId === block.blockId ? (
                <EmbeddedFormSlot spec={spec} />
              ) : null}
            </div>
          ))}

          {spec.kind === 'HYBRID' && !anchorBlockId ? <EmbeddedFormSlot spec={spec} /> : null}

          {spec.kind === 'HYBRID' && !embeddedForm ? (
            <Alert tone="warning">
              <AlertTitle>Formular nicht mitgeladen</AlertTitle>
              <AlertDescription>
                Diese Version verweist auf eine Formularversion, die hier nicht eingebettet
                vorliegt. Die Vorschau zeigt deshalb nur die Seite.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </ViewportFrame>
    </div>
  );
}

function EmbeddedFormSlot({ spec }: { spec: PageDocumentSpec }) {
  if (spec.kind !== 'HYBRID') return null;
  const { form, formSpec } = spec;

  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-dashed border-brand p-3"
      aria-label="Eingebettetes Formular"
      data-testid="embedded-form-slot"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand" size="sm">
          {form.mode === 'MODAL' ? 'Formular im Overlay' : 'Formular direkt auf der Seite'}
        </Badge>
        {form.mode === 'MODAL' ? (
          <span className="text-xs text-muted-foreground">{`Auslöser: ${form.triggerLabel}`}</span>
        ) : null}
      </div>
      {formSpec ? (
        <FormPreview spec={formSpec} noteDe="Eingebettetes Formular" />
      ) : (
        <p className="text-xs text-muted-foreground">
          {`Referenz auf Formularversion ${form.formVersionId}.`}
        </p>
      )}
    </section>
  );
}

export function BlockPreview({ block }: { block: PageBlock }) {
  return (
    <section
      data-testid={`block-preview-${block.blockId}`}
      data-block-type={block.type}
      id={block.anchor ?? undefined}
      className="flex flex-col gap-2 border-b border-border pb-4 last:border-b-0"
      aria-label={PAGE_BLOCK_LABELS_DE[block.type]}
    >
      <BlockBody block={block} />
    </section>
  );
}

function BlockBody({ block }: { block: PageBlock }) {
  switch (block.type) {
    case 'HERO':
      return (
        <>
          {block.eyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-wide text-brand">
              {block.eyebrow}
            </p>
          ) : null}
          <h2 className="text-lg font-semibold leading-tight text-foreground">{block.headline}</h2>
          {block.subline ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{block.subline}</p>
          ) : null}
          <Bullets items={block.bullets} />
          <Button type="button" block disabled title="In der Vorschau ohne Funktion">
            {block.primaryCta.label}
          </Button>
          {block.secondaryCta ? (
            <Button type="button" variant="ghost" block disabled>
              {block.secondaryCta.label}
            </Button>
          ) : null}
          {block.trustNote ? (
            <p className="text-xs text-muted-foreground">{block.trustNote}</p>
          ) : null}
        </>
      );

    case 'PROBLEM':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          {block.intro ? (
            <p className="text-sm text-muted-foreground">{block.intro}</p>
          ) : null}
          {block.points.map((point) => (
            <div key={point.key} className="rounded-md border border-border p-2">
              <p className="text-sm font-medium">{point.title}</p>
              <p className="text-sm text-muted-foreground">{point.body}</p>
            </div>
          ))}
        </>
      );

    case 'BENEFIT':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          {block.intro ? <p className="text-sm text-muted-foreground">{block.intro}</p> : null}
          {block.benefits.map((benefit) => (
            <div key={benefit.key} className="rounded-md border border-border p-2">
              <p className="text-sm font-medium">{benefit.title}</p>
              <p className="text-sm text-muted-foreground">{benefit.body}</p>
            </div>
          ))}
        </>
      );

    case 'PROOF':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          {block.points.map((point) => (
            <div key={point.key} className="flex flex-col gap-1 rounded-md border border-border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{point.value}</span>
                <span className="text-sm text-muted-foreground">{point.label}</span>
                <Badge tone={point.confidence === 'FACT' ? 'success' : 'warning'} size="sm">
                  {CONFIDENCE_LABELS_DE[point.confidence]}
                </Badge>
              </div>
              {point.note ? (
                <p className="text-xs text-muted-foreground">{point.note}</p>
              ) : null}
            </div>
          ))}
          {block.sourceNote ? (
            <p className="text-xs text-muted-foreground">{block.sourceNote}</p>
          ) : null}
        </>
      );

    case 'CASE_STUDY':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          <p className="text-sm font-medium">{block.client}</p>
          {block.industry ? (
            <p className="text-xs text-muted-foreground">{block.industry}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">{block.challenge}</p>
          <p className="text-sm text-muted-foreground">{block.approach}</p>
          <p className="text-sm text-muted-foreground">{block.outcome}</p>
          {block.metrics.map((metric) => (
            <p key={metric.key} className="text-sm">
              <span className="font-semibold">{metric.value}</span>{' '}
              <span className="text-muted-foreground">{metric.label}</span>
            </p>
          ))}
        </>
      );

    case 'TESTIMONIAL':
      return (
        <>
          {block.headline ? (
            <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          ) : null}
          {block.testimonials.map((entry) => (
            <figure key={entry.key} className="rounded-md border border-border p-2">
              <blockquote className="text-sm italic text-foreground">{entry.quote}</blockquote>
              <figcaption className="mt-1 text-xs text-muted-foreground">
                {[entry.authorName, entry.authorRole, entry.company].filter(Boolean).join(' · ')}
              </figcaption>
            </figure>
          ))}
        </>
      );

    case 'PROCESS':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          {block.intro ? <p className="text-sm text-muted-foreground">{block.intro}</p> : null}
          <ol className="flex flex-col gap-2">
            {block.steps.map((step, index) => (
              <li key={step.key} className="rounded-md border border-border p-2">
                <p className="text-sm font-medium">{`${index + 1}. ${step.title}`}</p>
                <p className="text-sm text-muted-foreground">{step.body}</p>
                {step.durationNote ? (
                  <p className="text-xs text-muted-foreground">{step.durationNote}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      );

    case 'COMPARISON':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          {block.intro ? <p className="text-sm text-muted-foreground">{block.intro}</p> : null}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="border border-border p-1 text-left" scope="col">
                    Kriterium
                  </th>
                  {block.columns.map((column) => (
                    <th key={column.key} className="border border-border p-1 text-left" scope="col">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row.key}>
                    <th className="border border-border p-1 text-left font-medium" scope="row">
                      {row.label}
                    </th>
                    {row.cells.map((cell, index) => (
                      <td key={index} className="border border-border p-1">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      );

    case 'OBJECTION_HANDLING':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          {block.objections.map((entry) => (
            <div key={entry.key} className="rounded-md border border-border p-2">
              <p className="text-sm font-medium">{entry.objection}</p>
              <p className="text-sm text-muted-foreground">{entry.response}</p>
            </div>
          ))}
        </>
      );

    case 'FAQ':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          {block.items.map((entry) => (
            <div key={entry.key} className="rounded-md border border-border p-2">
              <p className="text-sm font-medium">{entry.question}</p>
              <p className="text-sm text-muted-foreground">{entry.answer}</p>
            </div>
          ))}
        </>
      );

    case 'CTA':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          {block.body ? <p className="text-sm text-muted-foreground">{block.body}</p> : null}
          <Button type="button" block disabled title="In der Vorschau ohne Funktion">
            {block.cta.label}
          </Button>
          {block.urgencyNote ? (
            <p className="text-xs text-muted-foreground">{block.urgencyNote}</p>
          ) : null}
        </>
      );

    case 'TRUST':
      return (
        <>
          {block.headline ? (
            <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {block.badges.map((badge) => (
              <Badge key={badge.key} tone="neutral" size="sm">
                {badge.label}
              </Badge>
            ))}
          </div>
          {block.logos.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {`Logos: ${block.logos.map((logo) => logo.label).join(', ')}`}
            </p>
          ) : null}
        </>
      );

    case 'BOOKING_CTA':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          <p className="text-sm text-muted-foreground">{block.body}</p>
          <div className="rounded-md border border-border p-2 text-sm">
            <p className="font-medium">{block.booking.label}</p>
            <p className="text-xs text-muted-foreground">
              {block.booking.target
                ? `Ziel: ${block.booking.target.href}`
                : 'Terminbuchung noch nicht verbunden.'}
            </p>
          </div>
        </>
      );

    case 'EMBEDDED_CONTACT':
      return (
        <>
          <h2 className="text-base font-semibold text-foreground">{block.headline}</h2>
          {block.body ? <p className="text-sm text-muted-foreground">{block.body}</p> : null}
          <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
            {block.form.mode === 'MODAL'
              ? `Formular öffnet sich über „${block.form.triggerLabel}“.`
              : 'Formular wird an dieser Stelle direkt eingebettet.'}
          </p>
        </>
      );

    case 'FOOTER_LEGAL':
      return (
        <>
          <p className="text-xs text-muted-foreground">{block.companyLine}</p>
          <p className="text-xs text-muted-foreground">
            {`${block.imprintLink.href} · ${block.privacyLink.href}`}
          </p>
          {block.disclaimers.map((entry, index) => (
            <p key={index} className="text-xs text-muted-foreground">
              {entry}
            </p>
          ))}
        </>
      );

    default:
      return null;
  }
}

function Bullets({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}
