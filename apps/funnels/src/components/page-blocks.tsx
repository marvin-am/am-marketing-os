import { CheckCircle2, CalendarClock, Info, Quote } from 'lucide-react';
import { CONFIDENCE_LABELS_DE } from '@am/domain';
import type { CtaSpec, LinkTarget, PageBlock, ProofPoint } from '@am/funnel-schema';
import { resolveLinkTarget, type ResolvedTarget } from '@/server/redirect';
import { SpecMedia } from './spec-media';

/**
 * The landing-page block renderer.
 *
 * A page is a validated list of typed blocks, never a string of markup — the
 * spec owns the content and this component owns the markup, which is what makes
 * an AI-authored page safe to publish. All fifteen block types are rendered
 * here; a spec that can express a block the runtime silently drops is a page
 * that ships half-empty.
 *
 * Server component on purpose. There is no interactivity in a landing page
 * beyond in-page anchors and outbound links, and outbound links have to be
 * checked against the redirect allowlist on the server anyway.
 */

const SECTION = 'mx-auto w-full max-w-2xl min-w-0 px-4 py-8';
const H2 = 'break-words text-xl font-semibold tracking-tight text-foreground';
const BODY = 'break-words text-base leading-relaxed text-foreground';
const MUTED = 'break-words text-base leading-relaxed text-muted-foreground';

const PRIMARY_CTA =
  'inline-flex min-h-11 w-full items-center justify-center rounded-[var(--am-radius)] bg-brand px-4 py-2 text-base font-semibold text-brand-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--am-ring)]';
const GHOST_CTA =
  'inline-flex min-h-11 w-full items-center justify-center rounded-[var(--am-radius)] border border-border bg-surface px-4 py-2 text-base font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--am-ring)]';

export interface PageBlocksProps {
  blocks: readonly PageBlock[];
  /** Where an `OPEN_FORM` / `NEXT_STEP` CTA jumps to, when the page has a form. */
  formAnchor?: string | null;
  redirectAllowlist?: readonly string[];
  /**
   * The form runtime, rendered inside an `EMBEDDED_CONTACT` block. Passed in
   * rather than resolved here because loading a published form version is a
   * server concern and this component is also used to render blocks that carry
   * no form at all.
   */
  embeddedForm?: React.ReactNode;
}

function TargetLink({
  target,
  label,
  className,
}: {
  target: ResolvedTarget | null;
  label: string;
  className: string;
}) {
  if (!target) return null;
  if (!target.allowed) {
    return (
      <p className="flex min-w-0 items-start gap-2 rounded-[var(--am-radius)] border border-warning-border bg-warning-surface p-3 text-sm">
        <Info className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 break-words">{target.blockedReasonDe}</span>
      </p>
    );
  }
  return (
    <a
      href={target.href}
      className={className}
      target={target.newTab ? '_blank' : undefined}
      rel={target.newTab ? 'noopener noreferrer' : undefined}
    >
      {label}
    </a>
  );
}

function BlockCta({
  cta,
  formAnchor,
  allowlist,
  style,
}: {
  cta: CtaSpec | null;
  formAnchor: string | null;
  allowlist?: readonly string[];
  style?: 'PRIMARY' | 'GHOST';
}) {
  if (!cta) return null;
  const className = (style ?? cta.style) === 'GHOST' ? GHOST_CTA : PRIMARY_CTA;

  /* An in-app CTA jumps to the form on the page. Without a form there is
     nothing to jump to, so nothing is rendered — no dead buttons. */
  if (cta.action !== 'LINK') {
    if (!formAnchor) return null;
    return (
      <a href={`#${formAnchor}`} className={className}>
        {cta.label}
      </a>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      <TargetLink
        target={resolveLinkTarget(cta.target, allowlist)}
        label={cta.label}
        className={className}
      />
      {cta.note ? <p className="break-words text-sm text-muted-foreground">{cta.note}</p> : null}
    </div>
  );
}

function ProofRow({ point }: { point: ProofPoint }) {
  return (
    <li className="grid min-w-0 gap-1 rounded-[var(--am-radius)] border border-border bg-surface p-3">
      <p className="break-words text-2xl font-semibold tabular-nums text-foreground">
        {point.value}
      </p>
      <p className="break-words text-base font-medium text-foreground">{point.label}</p>
      {point.note ? <p className="break-words text-sm text-muted-foreground">{point.note}</p> : null}
      {/* A number is either backed by approved evidence or labelled a
          hypothesis. It is never presented bare. */}
      <p className="text-sm text-muted-foreground">
        Einordnung: {CONFIDENCE_LABELS_DE[point.confidence]}
      </p>
    </li>
  );
}

function LegalLink({
  target,
  label,
  allowlist,
}: {
  target: LinkTarget;
  label: string;
  allowlist?: readonly string[];
}) {
  const resolved = resolveLinkTarget(target, allowlist);
  if (!resolved?.allowed) return null;
  return (
    <a
      href={resolved.href}
      className="underline underline-offset-2"
      target={resolved.newTab ? '_blank' : undefined}
      rel={resolved.newTab ? 'noopener noreferrer' : undefined}
    >
      {label}
    </a>
  );
}

function Block({
  block,
  formAnchor,
  allowlist,
  isFirst,
  embeddedForm,
}: {
  block: PageBlock;
  formAnchor: string | null;
  allowlist?: readonly string[];
  isFirst: boolean;
  embeddedForm?: React.ReactNode;
}) {
  const anchorProps = block.anchor ? { id: block.anchor } : {};

  switch (block.type) {
    case 'HERO':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            {block.eyebrow ? (
              <p className="break-words text-sm font-semibold uppercase tracking-wide text-brand">
                {block.eyebrow}
              </p>
            ) : null}
            <h1 className="break-words text-3xl font-semibold tracking-tight text-foreground">
              {block.headline}
            </h1>
            {block.subline ? <p className={MUTED}>{block.subline}</p> : null}
            <SpecMedia
              media={block.media}
              priority={isFirst}
              className="rounded-[var(--am-radius)]"
            />
            {block.bullets.length > 0 ? (
              <ul className="grid min-w-0 gap-2">
                {block.bullets.map((bullet) => (
                  <li key={bullet} className="flex min-w-0 items-start gap-2">
                    <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />
                    <span className="min-w-0 break-words text-base">{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="grid min-w-0 gap-2">
              <BlockCta cta={block.primaryCta} formAnchor={formAnchor} allowlist={allowlist} />
              <BlockCta
                cta={block.secondaryCta}
                formAnchor={formAnchor}
                allowlist={allowlist}
                style="GHOST"
              />
            </div>
            {block.trustNote ? (
              <p className="break-words text-sm text-muted-foreground">{block.trustNote}</p>
            ) : null}
          </div>
        </section>
      );

    case 'PROBLEM':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            <h2 className={H2}>{block.headline}</h2>
            {block.intro ? <p className={MUTED}>{block.intro}</p> : null}
            <ul className="grid min-w-0 gap-3">
              {block.points.map((point) => (
                <li key={point.key} className="grid min-w-0 gap-1">
                  <h3 className="break-words text-base font-semibold">{point.title}</h3>
                  <p className={BODY}>{point.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      );

    case 'BENEFIT':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            <h2 className={H2}>{block.headline}</h2>
            {block.intro ? <p className={MUTED}>{block.intro}</p> : null}
            <ul className="grid min-w-0 gap-3">
              {block.benefits.map((benefit) => (
                <li
                  key={benefit.key}
                  className="grid min-w-0 gap-1 rounded-[var(--am-radius)] border border-border bg-surface p-3"
                >
                  <h3 className="break-words text-base font-semibold">{benefit.title}</h3>
                  <p className={BODY}>{benefit.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      );

    case 'PROOF':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            <h2 className={H2}>{block.headline}</h2>
            <ul className="grid min-w-0 gap-3">
              {block.points.map((point) => (
                <ProofRow key={point.key} point={point} />
              ))}
            </ul>
            {block.sourceNote ? (
              <p className="break-words text-sm text-muted-foreground">{block.sourceNote}</p>
            ) : null}
          </div>
        </section>
      );

    case 'CASE_STUDY':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            <h2 className={H2}>{block.headline}</h2>
            <p className="break-words text-sm text-muted-foreground">
              {block.client}
              {block.industry ? ` · ${block.industry}` : ''}
            </p>
            <div className="grid min-w-0 gap-3">
              <div className="grid min-w-0 gap-1">
                <h3 className="text-base font-semibold">Ausgangslage</h3>
                <p className={BODY}>{block.challenge}</p>
              </div>
              <div className="grid min-w-0 gap-1">
                <h3 className="text-base font-semibold">Vorgehen</h3>
                <p className={BODY}>{block.approach}</p>
              </div>
              <div className="grid min-w-0 gap-1">
                <h3 className="text-base font-semibold">Ergebnis</h3>
                <p className={BODY}>{block.outcome}</p>
              </div>
            </div>
            {block.metrics.length > 0 ? (
              <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
                {block.metrics.map((metric) => (
                  <div
                    key={metric.key}
                    className="min-w-0 rounded-[var(--am-radius)] border border-border bg-surface p-3"
                  >
                    <dt className="break-words text-sm text-muted-foreground">{metric.label}</dt>
                    <dd className="break-words text-lg font-semibold tabular-nums">
                      {metric.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <BlockCta cta={block.cta} formAnchor={formAnchor} allowlist={allowlist} />
          </div>
        </section>
      );

    case 'TESTIMONIAL':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            {block.headline ? <h2 className={H2}>{block.headline}</h2> : null}
            <ul className="grid min-w-0 gap-3">
              {block.testimonials.map((item) => (
                <li
                  key={item.key}
                  className="grid min-w-0 gap-2 rounded-[var(--am-radius)] border border-border bg-surface p-4"
                >
                  <Quote className="size-5 shrink-0 text-brand" aria-hidden="true" />
                  <blockquote className={BODY}>{item.quote}</blockquote>
                  <p className="break-words text-sm text-muted-foreground">
                    {item.authorName}
                    {item.authorRole ? `, ${item.authorRole}` : ''}
                    {item.company ? `, ${item.company}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      );

    case 'PROCESS':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            <h2 className={H2}>{block.headline}</h2>
            {block.intro ? <p className={MUTED}>{block.intro}</p> : null}
            <ol className="grid min-w-0 gap-3">
              {block.steps.map((step, index) => (
                <li key={step.key} className="flex min-w-0 items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-sm font-semibold text-brand-subtle-foreground"
                  >
                    {index + 1}
                  </span>
                  <div className="grid min-w-0 gap-1">
                    <h3 className="break-words text-base font-semibold">{step.title}</h3>
                    <p className={BODY}>{step.body}</p>
                    {step.durationNote ? (
                      <p className="break-words text-sm text-muted-foreground">
                        {step.durationNote}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>
      );

    case 'COMPARISON':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            <h2 className={H2}>{block.headline}</h2>
            {block.intro ? <p className={MUTED}>{block.intro}</p> : null}
            {/* The table is the one element that legitimately wants more width
                than a 320 px viewport, so it scrolls inside its own box rather
                than making the page scroll sideways. */}
            <div className="w-full min-w-0 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="p-2 font-medium text-muted-foreground">
                      <span className="sr-only">Kriterium</span>
                    </th>
                    {block.columns.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        className={
                          column.highlight
                            ? 'p-2 font-semibold text-brand'
                            : 'p-2 font-medium text-foreground'
                        }
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row) => (
                    <tr key={row.key} className="border-t border-border align-top">
                      <th scope="row" className="p-2 font-medium text-foreground">
                        {row.label}
                      </th>
                      {row.cells.map((cell, index) => (
                        <td key={`${row.key}-${index}`} className="p-2 text-muted-foreground">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      );

    case 'OBJECTION_HANDLING':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            <h2 className={H2}>{block.headline}</h2>
            <ul className="grid min-w-0 gap-3">
              {block.objections.map((item) => (
                <li key={item.key} className="grid min-w-0 gap-1">
                  <h3 className="break-words text-base font-semibold">„{item.objection}“</h3>
                  <p className={BODY}>{item.response}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      );

    case 'FAQ':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            <h2 className={H2}>{block.headline}</h2>
            <div className="grid min-w-0 gap-2">
              {block.items.map((item) => (
                <details
                  key={item.key}
                  className="min-w-0 rounded-[var(--am-radius)] border border-border bg-surface p-3"
                >
                  <summary className="min-h-11 cursor-pointer break-words py-2 text-base font-medium">
                    {item.question}
                  </summary>
                  <p className={BODY}>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      );

    case 'CTA':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4 rounded-[var(--am-radius)] border border-border bg-surface-sunken p-4">
            <h2 className={H2}>{block.headline}</h2>
            {block.body ? <p className={BODY}>{block.body}</p> : null}
            <BlockCta cta={block.cta} formAnchor={formAnchor} allowlist={allowlist} />
            {block.urgencyNote ? (
              <p className="break-words text-sm text-muted-foreground">{block.urgencyNote}</p>
            ) : null}
          </div>
        </section>
      );

    case 'TRUST':
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            {block.headline ? <h2 className={H2}>{block.headline}</h2> : null}
            {block.badges.length > 0 ? (
              <ul className="grid min-w-0 gap-2">
                {block.badges.map((badge) => (
                  <li key={badge.key} className="flex min-w-0 items-start gap-2">
                    <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block break-words text-base font-medium">{badge.label}</span>
                      {badge.note ? (
                        <span className="block break-words text-sm text-muted-foreground">
                          {badge.note}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {block.logos.length > 0 ? (
              <ul className="flex min-w-0 flex-wrap gap-3">
                {block.logos.map((logo) => (
                  <li key={logo.key} className="min-w-0">
                    {logo.media ? (
                      <SpecMedia media={logo.media} className="h-8 w-auto" />
                    ) : (
                      <span className="break-words text-sm text-muted-foreground">{logo.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      );

    case 'BOOKING_CTA': {
      const bookingTarget = resolveLinkTarget(block.booking.target, allowlist);
      return (
        <section {...anchorProps} className={SECTION}>
          <div className="grid min-w-0 gap-4">
            <h2 className={H2}>{block.headline}</h2>
            <p className={BODY}>{block.body}</p>
            {bookingTarget?.allowed ? (
              <TargetLink
                target={bookingTarget}
                label={block.booking.label}
                className={PRIMARY_CTA}
              />
            ) : (
              <p className="flex min-w-0 items-start gap-2 rounded-[var(--am-radius)] border border-warning-border bg-warning-surface p-3 text-sm">
                <CalendarClock className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
                <span className="min-w-0 break-words">
                  Die Terminbuchung ist noch nicht verbunden.
                </span>
              </p>
            )}
            {block.booking.helpText ? (
              <p className="break-words text-sm text-muted-foreground">{block.booking.helpText}</p>
            ) : null}
          </div>
        </section>
      );
    }

    case 'EMBEDDED_CONTACT':
      return (
        <section {...anchorProps} className="w-full min-w-0">
          <div className={SECTION}>
            <div className="grid min-w-0 gap-2">
              <h2 className={H2}>{block.headline}</h2>
              {block.body ? <p className={MUTED}>{block.body}</p> : null}
            </div>
          </div>
          {/* The form itself. When the referenced version is not published there
              is deliberately nothing here rather than a disabled placeholder —
              the block above still states what the page is for. */}
          {embeddedForm}
        </section>
      );

    case 'FOOTER_LEGAL':
      return (
        <footer {...anchorProps} className="border-t border-border bg-surface-sunken">
          <div className={SECTION}>
            <div className="grid min-w-0 gap-3 text-sm text-muted-foreground">
              <p className="break-words">{block.companyLine}</p>
              <nav className="flex min-w-0 flex-wrap gap-x-4 gap-y-2">
                <LegalLink target={block.imprintLink} label="Impressum" allowlist={allowlist} />
                <LegalLink target={block.privacyLink} label="Datenschutz" allowlist={allowlist} />
                {block.additionalLinks.map((link) => (
                  <LegalLink
                    key={link.key}
                    target={link.target}
                    label={link.label}
                    allowlist={allowlist}
                  />
                ))}
              </nav>
              {block.disclaimers.map((disclaimer) => (
                <p key={disclaimer} className="break-words">
                  {disclaimer}
                </p>
              ))}
            </div>
          </div>
        </footer>
      );

    default:
      return null;
  }
}

export function PageBlocks({
  blocks,
  formAnchor = null,
  redirectAllowlist,
  embeddedForm,
}: PageBlocksProps) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block
          key={block.blockId}
          block={block}
          formAnchor={formAnchor}
          allowlist={redirectAllowlist}
          isFirst={index === 0}
          embeddedForm={embeddedForm}
        />
      ))}
    </>
  );
}
