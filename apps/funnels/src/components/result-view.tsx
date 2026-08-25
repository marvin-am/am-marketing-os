'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, CalendarClock, Download, Info } from 'lucide-react';
import {
  matchesOptional,
  type Answers,
  type BookingSpec,
  type CtaSpec,
  type MultiStepFormSpec,
  type ResultVariant,
} from '@am/funnel-schema';
import type { ResolvedRedirect, ResolvedTarget } from '@/server/redirect';
import type { FormTargets } from '@/server/spec-targets';
import { headingTag, type HeadingLevel } from '@/lib/heading-level';

/**
 * The terminal states.
 *
 * All seven result kinds the schema can express are rendered here — thank-you,
 * lead magnet, rule-based analysis, qualified, not-a-fit, booking and redirect —
 * because a spec that can express a state the runtime cannot render is a
 * publish-time trap.
 *
 * Two rules shape what is *not* here:
 *
 * - **No dead controls.** A CTA is rendered only when there is something real to
 *   do: a booking link that has not been supplied stays `null` in the spec and
 *   is shown as "noch nicht verbunden", never as a button that does nothing.
 * - **No unchecked redirect.** The target was resolved against the allowlist on
 *   the server; a blocked one arrives as `null` and the visitor simply stays on
 *   the thank-you state.
 */

export interface ResultViewProps {
  spec: MultiStepFormSpec;
  variant: ResultVariant | null;
  targets: FormTargets;
  answers: Answers;
  /** Present only once a submission was accepted. */
  redirect: ResolvedRedirect | null;
  /**
   * Level of the result headline. `1` when the form is the whole document; `2`
   * when a page around it already carries the `h1`. The panel replaces the form
   * in place, so it inherits whatever level the form was rendered with.
   */
  headingLevel?: HeadingLevel;
  onBookingStart?: () => void;
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-live="polite"
      className="grid min-w-0 gap-4 rounded-[var(--am-radius)] border border-border bg-surface p-5"
    >
      {children}
    </section>
  );
}

function Headline({ level, children }: { level: HeadingLevel; children: React.ReactNode }) {
  const Tag = headingTag(level);
  return (
    <Tag className="break-words text-2xl font-semibold tracking-tight text-foreground">
      {children}
    </Tag>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="break-words text-base leading-relaxed text-foreground">{children}</p>;
}

function Bullets({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="grid min-w-0 gap-2">
      {items.map((item) => (
        <li key={item} className="flex min-w-0 items-start gap-2">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />
          <span className="min-w-0 break-words text-base">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function LinkButton({
  target,
  label,
  onActivate,
}: {
  target: ResolvedTarget | null;
  label: string;
  onActivate?: () => void;
}) {
  if (!target || !target.allowed) return null;
  return (
    <a
      href={target.href}
      onClick={onActivate}
      target={target.newTab ? '_blank' : undefined}
      rel={target.newTab ? 'noopener noreferrer' : undefined}
      className="inline-flex min-h-11 w-full items-center justify-center rounded-[var(--am-radius)] bg-brand px-4 py-2 text-base font-semibold text-brand-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--am-ring)]"
    >
      {label}
    </a>
  );
}

function Cta({
  cta,
  target,
  onActivate,
}: {
  cta: CtaSpec | null;
  target: ResolvedTarget | null;
  onActivate?: () => void;
}) {
  /* An in-app action on a terminal screen has nothing left to do, so only a
     real link is rendered. A button that does nothing is worse than no button. */
  if (!cta || cta.action !== 'LINK') return null;
  return (
    <div className="grid min-w-0 gap-2">
      <LinkButton target={target} label={cta.label} onActivate={onActivate} />
      {cta.note ? <p className="break-words text-sm text-muted-foreground">{cta.note}</p> : null}
    </div>
  );
}

function Booking({
  booking,
  target,
  onActivate,
}: {
  booking: BookingSpec | null;
  target: ResolvedTarget | null;
  onActivate?: () => void;
}) {
  if (!booking) return null;

  if (!booking.target || !target || !target.allowed) {
    return (
      <p className="flex min-w-0 items-start gap-2 rounded-[var(--am-radius)] border border-warning-border bg-warning-surface p-3 text-sm text-foreground">
        <CalendarClock className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 break-words">
          Die Terminbuchung ist noch nicht verbunden. Wir melden uns stattdessen persönlich bei
          Ihnen.
        </span>
      </p>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      <LinkButton target={target} label={booking.label} onActivate={onActivate} />
      {booking.helpText ? (
        <p className="break-words text-sm text-muted-foreground">{booking.helpText}</p>
      ) : null}
    </div>
  );
}

/** Counts down and then performs a redirect the server already allow-listed. */
function RedirectNotice({ redirect }: { redirect: ResolvedRedirect }) {
  const [remaining, setRemaining] = useState(redirect.delaySeconds);

  useEffect(() => {
    if (remaining <= 0) {
      globalThis.location?.assign(redirect.href);
      return;
    }
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining, redirect.href]);

  return (
    <p className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        Sie werden in {Math.max(0, remaining)} Sekunden weitergeleitet.{' '}
        <a className="underline underline-offset-2" href={redirect.href}>
          Jetzt fortfahren
        </a>
      </span>
    </p>
  );
}

export function ResultView({
  spec,
  variant,
  targets,
  answers,
  redirect,
  headingLevel = 1,
  onBookingStart,
}: ResultViewProps) {
  const variantTargets = variant ? targets.variants[variant.variantId] : undefined;
  /* An analysis section is a subsection of the result, so it follows the
     headline down rather than sitting beside it. */
  const SectionHeading = headingTag(headingLevel, 1);

  if (!variant) {
    return (
      <Panel>
        <Headline level={headingLevel}>{spec.success.headline}</Headline>
        <Body>{spec.success.body}</Body>
        <Bullets items={spec.success.bullets} />
        {redirect ? <RedirectNotice redirect={redirect} /> : null}
      </Panel>
    );
  }

  const shared = (
    <>
      <Headline level={headingLevel}>{variant.headline}</Headline>
      <Body>{variant.body}</Body>
    </>
  );

  switch (variant.kind) {
    case 'THANK_YOU':
      return (
        <Panel>
          {shared}
          <Bullets items={variant.bullets} />
          <Cta cta={variant.cta} target={variantTargets?.cta ?? null} />
          {spec.success.legalNote ? (
            <p className="break-words text-sm text-muted-foreground">{spec.success.legalNote}</p>
          ) : null}
          {redirect ? <RedirectNotice redirect={redirect} /> : null}
        </Panel>
      );

    case 'LEAD_MAGNET':
      return (
        <Panel>
          {shared}
          {variant.assetPath ? (
            <a
              href={variant.assetPath}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--am-radius)] bg-brand px-4 py-2 text-base font-semibold text-brand-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--am-ring)]"
            >
              <Download className="size-5 shrink-0" aria-hidden="true" />
              {variant.assetLabel}
            </a>
          ) : (
            <p className="flex min-w-0 items-start gap-2 rounded-[var(--am-radius)] border border-warning-border bg-warning-surface p-3 text-sm">
              <Info className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 break-words">
                Die Unterlagen sind noch nicht hinterlegt. Wir senden sie Ihnen per E-Mail zu.
              </span>
            </p>
          )}
          <p className="break-words text-sm text-muted-foreground">{variant.deliveryNote}</p>
          {redirect ? <RedirectNotice redirect={redirect} /> : null}
        </Panel>
      );

    case 'ANALYSIS':
      return (
        <Panel>
          {shared}
          <div className="grid min-w-0 gap-4">
            {variant.sections
              .filter((section) => matchesOptional(section.showWhen, answers))
              .map((section) => (
                <div key={section.key} className="grid min-w-0 gap-1">
                  <SectionHeading className="break-words text-lg font-semibold text-foreground">
                    {section.title}
                  </SectionHeading>
                  <p className="break-words text-base leading-relaxed text-foreground">
                    {section.body}
                  </p>
                </div>
              ))}
          </div>
          {/* Every computed statement carries its method note — the model may
              explain, it may never produce a number on its own. */}
          <p className="break-words text-sm text-muted-foreground">{variant.methodNote}</p>
          <Cta cta={variant.cta} target={variantTargets?.cta ?? null} />
          {redirect ? <RedirectNotice redirect={redirect} /> : null}
        </Panel>
      );

    case 'QUALIFIED':
      return (
        <Panel>
          {shared}
          <Bullets items={variant.bullets} />
          <Booking
            booking={variant.booking}
            target={variantTargets?.booking ?? null}
            onActivate={onBookingStart}
          />
          <Cta cta={variant.cta} target={variantTargets?.cta ?? null} />
          {redirect ? <RedirectNotice redirect={redirect} /> : null}
        </Panel>
      );

    case 'NOT_A_FIT':
      return (
        <Panel>
          {shared}
          <p className="break-words rounded-[var(--am-radius)] border border-border bg-surface-sunken p-3 text-base">
            {variant.alternativeNote}
          </p>
          <Cta cta={variant.cta} target={variantTargets?.cta ?? null} />
        </Panel>
      );

    case 'BOOKING':
      return (
        <Panel>
          {shared}
          <Bullets items={variant.bullets} />
          <Booking
            booking={variant.booking}
            target={variantTargets?.booking ?? null}
            onActivate={onBookingStart}
          />
          {redirect ? <RedirectNotice redirect={redirect} /> : null}
        </Panel>
      );

    case 'REDIRECT':
      return (
        <Panel>
          {shared}
          {redirect ? (
            <RedirectNotice redirect={redirect} />
          ) : (
            /* The target was not on the allowlist. The visitor stays here with
               an honest message rather than being sent somewhere unverified. */
            <p className="flex min-w-0 items-start gap-2 rounded-[var(--am-radius)] border border-warning-border bg-warning-surface p-3 text-sm">
              <Info className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 break-words">
                Die Weiterleitung ist nicht freigegeben. Ihre Anfrage ist trotzdem bei uns
                eingegangen.
              </span>
            </p>
          )}
        </Panel>
      );

    default:
      return null;
  }
}
