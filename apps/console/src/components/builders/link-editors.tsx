'use client';

import * as React from 'react';
import {
  anchorLink,
  externalLink,
  internalLink,
  BOOKING_MODES,
  CTA_ACTIONS,
  CTA_STYLES,
  MEDIA_ASPECTS,
  type BookingSpec,
  type CtaSpec,
  type LinkTarget,
  type MediaRef,
  type ValidationIssue,
} from '@am/funnel-schema';
import { Button, Label, Switch } from '@am/ui';
import { NativeSelect, OptionalTextControl, NumberControl, SelectControl, TextControl } from './controls';
import { InlineIssues } from './issue-views';
import {
  BOOKING_MODE_LABELS_DE,
  CTA_ACTION_LABELS_DE,
  CTA_STYLE_LABELS_DE,
  MEDIA_ASPECT_LABELS_DE,
} from './labels';

/**
 * Editors for the spec fragments that point somewhere: links, CTAs, booking
 * offers and media references.
 *
 * The link editor is the reason this file exists. A spec may only carry an
 * external target when it is flagged for the redirect allowlist, so the editor
 * offers three explicit kinds of destination and sets the flags itself. There is
 * no control that produces an unflagged external URL, and "no link yet" stays
 * `null` rather than becoming an invented address.
 */

type LinkKind = 'INTERNAL' | 'ANCHOR' | 'EXTERNAL';

function kindOf(target: LinkTarget): LinkKind {
  if (target.external) return 'EXTERNAL';
  return target.href.startsWith('#') ? 'ANCHOR' : 'INTERNAL';
}

const LINK_KIND_LABELS_DE: Readonly<Record<LinkKind, string>> = {
  INTERNAL: 'Interner Pfad (z. B. /danke)',
  ANCHOR: 'Sprungpunkt auf dieser Seite (z. B. #formular)',
  EXTERNAL: 'Externe HTTPS-Adresse (Allowlist-Prüfung nötig)',
};

export interface LinkTargetEditorProps {
  labelDe: string;
  target: LinkTarget;
  onChange: (target: LinkTarget) => void;
  disabled?: boolean;
  issues?: readonly ValidationIssue[];
  allowAnchor?: boolean;
}

export function LinkTargetEditor({
  labelDe,
  target,
  onChange,
  disabled = false,
  issues = [],
  allowAnchor = true,
}: LinkTargetEditorProps) {
  const baseId = React.useId();
  const kind = kindOf(target);
  const kinds: LinkKind[] = allowAnchor
    ? ['INTERNAL', 'ANCHOR', 'EXTERNAL']
    : ['INTERNAL', 'EXTERNAL'];

  const changeKind = (next: LinkKind) => {
    if (next === 'EXTERNAL') onChange(externalLink('https://', target.newTab));
    else if (next === 'ANCHOR') onChange(anchorLink('abschnitt'));
    else onChange(internalLink('/danke', target.newTab));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${baseId}-kind`}>{labelDe}</Label>
        <NativeSelect
          id={`${baseId}-kind`}
          value={kind}
          disabled={disabled}
          onChange={(event) => changeKind(event.target.value as LinkKind)}
        >
          {kinds.map((entry) => (
            <option key={entry} value={entry}>
              {LINK_KIND_LABELS_DE[entry]}
            </option>
          ))}
        </NativeSelect>
      </div>

      <TextControl
        label="Ziel"
        value={target.href}
        disabled={disabled}
        maxLength={500}
        hint={
          kind === 'EXTERNAL'
            ? 'Externe Ziele werden vor der Veröffentlichung gegen die Redirect-Allowlist geprüft. Bis dahin bleibt eine Warnung stehen.'
            : kind === 'ANCHOR'
              ? 'Muss auf einen Block dieser Seite verweisen.'
              : 'Anwendungsinterner Pfad, beginnt mit einem Schrägstrich.'
        }
        onChange={(href) =>
          onChange(
            kind === 'EXTERNAL'
              ? { href, external: true, requiresAllowlist: true, newTab: target.newTab }
              : { href, external: false, requiresAllowlist: false, newTab: target.newTab },
          )
        }
      />

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${baseId}-newtab`}>In neuem Tab öffnen</Label>
        <Switch
          id={`${baseId}-newtab`}
          checked={target.newTab}
          disabled={disabled}
          onCheckedChange={(newTab) => onChange({ ...target, newTab })}
        />
      </div>

      <InlineIssues issues={issues} />
    </div>
  );
}

export interface OptionalLinkTargetEditorProps extends Omit<LinkTargetEditorProps, 'target' | 'onChange'> {
  target: LinkTarget | null;
  onChange: (target: LinkTarget | null) => void;
  /** German explanation of what "kein Ziel" means here. */
  emptyHintDe: string;
}

export function OptionalLinkTargetEditor({
  target,
  onChange,
  emptyHintDe,
  labelDe,
  disabled = false,
  issues = [],
  allowAnchor,
}: OptionalLinkTargetEditorProps) {
  if (!target) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
        <p className="text-sm font-medium text-foreground">{labelDe}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{emptyHintDe}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="self-start"
          onClick={() => onChange(internalLink('/danke'))}
        >
          Ziel hinterlegen
        </Button>
        <InlineIssues issues={issues} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <LinkTargetEditor
        labelDe={labelDe}
        target={target}
        onChange={onChange}
        disabled={disabled}
        issues={issues}
        allowAnchor={allowAnchor}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        className="self-start"
        onClick={() => onChange(null)}
      >
        Ziel entfernen
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* CTA                                                                         */
/* -------------------------------------------------------------------------- */

export interface CtaEditorProps {
  labelDe: string;
  cta: CtaSpec;
  onChange: (cta: CtaSpec) => void;
  disabled?: boolean;
  issues?: readonly ValidationIssue[];
}

export function CtaEditor({ labelDe, cta, onChange, disabled = false, issues = [] }: CtaEditorProps) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <p className="text-sm font-semibold text-foreground">{labelDe}</p>
      <TextControl
        label="Beschriftung"
        value={cta.label}
        maxLength={80}
        disabled={disabled}
        onChange={(label) => onChange({ ...cta, label })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectControl
          label="Aktion"
          value={cta.action}
          disabled={disabled}
          options={CTA_ACTIONS.map((action) => ({
            value: action,
            labelDe: CTA_ACTION_LABELS_DE[action],
          }))}
          onChange={(action) =>
            onChange({
              ...cta,
              action,
              target: action === 'LINK' ? (cta.target ?? internalLink('/danke')) : cta.target,
            })
          }
        />
        <SelectControl
          label="Darstellung"
          value={cta.style}
          disabled={disabled}
          options={CTA_STYLES.map((style) => ({
            value: style,
            labelDe: CTA_STYLE_LABELS_DE[style],
          }))}
          onChange={(style) => onChange({ ...cta, style })}
        />
      </div>
      {cta.action === 'LINK' ? (
        <LinkTargetEditor
          labelDe="Art des Ziels"
          target={cta.target ?? internalLink('/danke')}
          disabled={disabled}
          onChange={(target) => onChange({ ...cta, target })}
        />
      ) : null}
      <OptionalTextControl
        label="Hinweis unter der Schaltfläche"
        value={cta.note}
        maxLength={160}
        disabled={disabled}
        onChange={(note) => onChange({ ...cta, note })}
      />
      <InlineIssues issues={issues} />
    </div>
  );
}

export interface OptionalCtaEditorProps extends Omit<CtaEditorProps, 'cta' | 'onChange'> {
  cta: CtaSpec | null;
  onChange: (cta: CtaSpec | null) => void;
}

export function OptionalCtaEditor({
  labelDe,
  cta,
  onChange,
  disabled = false,
  issues = [],
}: OptionalCtaEditorProps) {
  if (!cta) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
        <p className="text-sm font-medium text-foreground">{labelDe}</p>
        <p className="text-xs text-muted-foreground">Keine Schaltfläche hinterlegt.</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="self-start"
          onClick={() =>
            onChange({
              label: 'Jetzt Termin sichern',
              action: 'BOOKING',
              target: null,
              style: 'PRIMARY',
              note: null,
            })
          }
        >
          Schaltfläche hinzufügen
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <CtaEditor
        labelDe={labelDe}
        cta={cta}
        onChange={onChange}
        disabled={disabled}
        issues={issues}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        className="self-start"
        onClick={() => onChange(null)}
      >
        Schaltfläche entfernen
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Booking                                                                     */
/* -------------------------------------------------------------------------- */

export interface BookingEditorProps {
  booking: BookingSpec;
  onChange: (booking: BookingSpec) => void;
  disabled?: boolean;
  issues?: readonly ValidationIssue[];
}

export function BookingEditor({
  booking,
  onChange,
  disabled = false,
  issues = [],
}: BookingEditorProps) {
  return (
    <div className="flex flex-col gap-3">
      <TextControl
        label="Beschriftung der Terminschaltfläche"
        value={booking.label}
        maxLength={80}
        disabled={disabled}
        onChange={(label) => onChange({ ...booking, label })}
      />
      <SelectControl
        label="Art der Terminbuchung"
        value={booking.mode}
        disabled={disabled}
        options={BOOKING_MODES.map((mode) => ({
          value: mode,
          labelDe: BOOKING_MODE_LABELS_DE[mode],
        }))}
        onChange={(mode) => onChange({ ...booking, mode })}
      />
      <OptionalLinkTargetEditor
        labelDe="Terminbuchungs-Link"
        target={booking.target}
        disabled={disabled}
        allowAnchor={false}
        emptyHintDe="Noch kein Buchungslink hinterlegt. Bis dahin zeigt die Strecke „Terminbuchung noch nicht verbunden“ statt einer erfundenen Adresse."
        onChange={(target) => onChange({ ...booking, target })}
      />
      <OptionalTextControl
        label="Hinweis zur Terminbuchung"
        value={booking.helpText}
        maxLength={300}
        disabled={disabled}
        onChange={(helpText) => onChange({ ...booking, helpText })}
      />
      <InlineIssues issues={issues} />
    </div>
  );
}

export interface OptionalBookingEditorProps extends Omit<BookingEditorProps, 'booking' | 'onChange'> {
  booking: BookingSpec | null;
  onChange: (booking: BookingSpec | null) => void;
  labelDe: string;
}

export function OptionalBookingEditor({
  booking,
  onChange,
  labelDe,
  disabled = false,
  issues = [],
}: OptionalBookingEditorProps) {
  if (!booking) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
        <p className="text-sm font-medium text-foreground">{labelDe}</p>
        <p className="text-xs text-muted-foreground">Keine Terminbuchung auf diesem Abschluss.</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="self-start"
          onClick={() =>
            onChange({
              mode: 'LINK',
              target: null,
              label: 'Termin auswählen',
              helpText: null,
            })
          }
        >
          Terminbuchung anbieten
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm font-semibold text-foreground">{labelDe}</p>
      <BookingEditor
        booking={booking}
        onChange={onChange}
        disabled={disabled}
        issues={issues}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        className="self-start"
        onClick={() => onChange(null)}
      >
        Terminbuchung entfernen
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Media                                                                       */
/* -------------------------------------------------------------------------- */

export interface MediaEditorProps {
  labelDe: string;
  media: MediaRef | null;
  onChange: (media: MediaRef | null) => void;
  disabled?: boolean;
}

export function MediaEditor({ labelDe, media, onChange, disabled = false }: MediaEditorProps) {
  if (!media) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
        <p className="text-sm font-medium text-foreground">{labelDe}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Kein Medium hinterlegt. Bilder und Videos werden in der Library gepflegt und über ihren
          Speicherpfad eingebunden.
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="self-start"
          onClick={() =>
            onChange({ kind: 'IMAGE', assetPath: '/assets/', alt: 'Bildbeschreibung', aspect: '4:5' })
          }
        >
          Medium einbinden
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <p className="text-sm font-semibold text-foreground">{labelDe}</p>
      <SelectControl
        label="Art"
        value={media.kind}
        disabled={disabled}
        options={[
          { value: 'IMAGE' as const, labelDe: 'Bild' },
          { value: 'VIDEO' as const, labelDe: 'Video' },
        ]}
        onChange={(kind) => onChange({ ...media, kind })}
      />
      <TextControl
        label="Speicherpfad"
        value={media.assetPath}
        maxLength={500}
        disabled={disabled}
        hint="Anwendungsinterner Pfad. Externe Adressen sind nicht zulässig."
        onChange={(assetPath) => onChange({ ...media, assetPath })}
      />
      <TextControl
        label="Alternativtext"
        value={media.alt}
        maxLength={300}
        disabled={disabled}
        hint="Beschreibt das Medium für Screenreader und wenn es nicht geladen werden kann."
        onChange={(alt) => onChange({ ...media, alt })}
      />
      <SelectControl
        label="Seitenverhältnis"
        value={media.aspect}
        disabled={disabled}
        options={MEDIA_ASPECTS.map((aspect) => ({
          value: aspect,
          labelDe: MEDIA_ASPECT_LABELS_DE[aspect],
        }))}
        onChange={(aspect) => onChange({ ...media, aspect })}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        className="self-start"
        onClick={() => onChange(null)}
      >
        Medium entfernen
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Redirect                                                                    */
/* -------------------------------------------------------------------------- */

export interface RedirectEditorProps {
  target: LinkTarget;
  delaySeconds: number;
  onChange: (next: { target: LinkTarget; delaySeconds: number }) => void;
  disabled?: boolean;
  issues?: readonly ValidationIssue[];
}

export function RedirectEditor({
  target,
  delaySeconds,
  onChange,
  disabled = false,
  issues = [],
}: RedirectEditorProps) {
  return (
    <div className="flex flex-col gap-3">
      <LinkTargetEditor
        labelDe="Weiterleitungsziel"
        target={target}
        disabled={disabled}
        allowAnchor={false}
        issues={issues}
        onChange={(next) => onChange({ target: next, delaySeconds })}
      />
      <NumberControl
        label="Verzögerung in Sekunden"
        value={delaySeconds}
        min={0}
        max={30}
        disabled={disabled}
        hint="Zeit, in der das Ergebnis noch sichtbar bleibt, bevor weitergeleitet wird."
        onChange={(seconds) =>
          onChange({ target, delaySeconds: Math.min(30, Math.max(0, Math.round(seconds))) })
        }
      />
    </div>
  );
}
