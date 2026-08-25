'use client';

import { CONSENT_PURPOSES, type ConsentPurpose } from '@am/domain';
import type { MultiStepFormSpec, ValidationIssue } from '@am/funnel-schema';
import { Alert, AlertDescription, AlertTitle, Section } from '@am/ui';
import type { ConsentTextOption } from '../port';
import {
  CheckboxGroupControl,
  NumberControl,
  OptionalTextControl,
  SelectControl,
  StringListControl,
  SwitchControl,
  TextareaControl,
  TextControl,
} from '../controls';
import { InlineIssues } from '../issue-views';
import { MediaEditor, OptionalBookingEditor, OptionalCtaEditor } from '../link-editors';

/**
 * The screens around the questions: the intro/offer screen, the consent block,
 * the submit behaviour and the thank-you state.
 *
 * The consent text is deliberately **not** editable. A consent version is the
 * exact legal text a visitor agreed to; rewriting it in place would change what
 * historical consents mean. The operator picks one of the available versions
 * instead, and the field's version follows the pick so the two can never drift
 * apart.
 */

export type { ConsentTextOption };

const PURPOSE_LABELS_DE: Readonly<Record<ConsentPurpose, string>> = {
  CONTACT: 'Kontaktaufnahme zur Anfrage',
  MARKETING_EMAIL: 'Werbliche E-Mails',
  ANALYTICS: 'Reichweitenmessung',
  AD_MEASUREMENT: 'Werbeerfolgsmessung',
};

export interface IntroEditorProps {
  spec: MultiStepFormSpec;
  issues: readonly ValidationIssue[];
  disabled: boolean;
  onSpecChange: (spec: MultiStepFormSpec) => void;
}

export function IntroEditor({ spec, issues, disabled, onSpecChange }: IntroEditorProps) {
  const intro = spec.intro;
  const patch = (next: Partial<typeof intro>) =>
    onSpecChange({ ...spec, intro: { ...intro, ...next } });

  return (
    <Section
      heading="Startbildschirm"
      headingLevel={3}
      description="Was Besucherinnen und Besucher sehen, bevor die erste Frage erscheint."
    >
      <div className="flex flex-col gap-4">
        <TextControl
          label="Titel der Strecke"
          hint="Interner und externer Name dieser Formularversion."
          value={spec.title}
          maxLength={200}
          disabled={disabled}
          onChange={(title) => onSpecChange({ ...spec, title })}
        />
        <OptionalTextControl
          label="Kleine Überzeile"
          value={intro.eyebrow}
          maxLength={80}
          disabled={disabled}
          onChange={(eyebrow) => patch({ eyebrow })}
        />
        <TextControl
          label="Überschrift"
          value={intro.headline}
          maxLength={160}
          disabled={disabled}
          onChange={(headline) => patch({ headline })}
        />
        <TextareaControl
          label="Einleitung"
          value={intro.subline ?? ''}
          maxLength={400}
          rows={3}
          disabled={disabled}
          onChange={(subline) => patch({ subline: subline.trim().length === 0 ? null : subline })}
        />
        <StringListControl
          label="Stichpunkte"
          itemNounDe="Stichpunkt"
          values={intro.bullets}
          disabled={disabled}
          onChange={(bullets) => patch({ bullets })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <OptionalTextControl
            label="Aufwandsversprechen"
            hint="Zum Beispiel „2 Minuten“. Nur angeben, wenn es stimmt."
            value={intro.effortPromise}
            maxLength={80}
            disabled={disabled}
            onChange={(effortPromise) => patch({ effortPromise })}
          />
          <TextControl
            label="Beschriftung der Start-Schaltfläche"
            value={intro.primaryCtaLabel}
            maxLength={60}
            disabled={disabled}
            onChange={(primaryCtaLabel) => patch({ primaryCtaLabel })}
          />
        </div>
        <OptionalTextControl
          label="Vertrauenshinweis"
          value={intro.trustNote}
          maxLength={200}
          disabled={disabled}
          onChange={(trustNote) => patch({ trustNote })}
        />
        <MediaEditor
          labelDe="Medium auf dem Startbildschirm"
          media={intro.media}
          disabled={disabled}
          onChange={(media) => patch({ media })}
        />
        <InlineIssues issues={issues.filter((issue) => issue.pathDe.startsWith('intro'))} />
      </div>
    </Section>
  );
}

export interface ConsentSubmitEditorProps extends IntroEditorProps {
  consentTexts: readonly ConsentTextOption[];
}

export function ConsentSubmitEditor({
  spec,
  issues,
  disabled,
  onSpecChange,
  consentTexts,
}: ConsentSubmitEditorProps) {
  const consent = spec.consent;
  const submit = spec.submit;
  const success = spec.success;
  const consentIssues = issues.filter((issue) => issue.pathDe.startsWith('Einwilligung'));

  const pickConsentText = (consentVersionId: string) => {
    const picked = consentTexts.find((entry) => entry.consentVersionId === consentVersionId);
    if (!picked) return;
    const field = spec.fields[consent.fieldId];
    onSpecChange({
      ...spec,
      consent: {
        ...consent,
        consentVersionId: picked.consentVersionId,
        textDe: picked.textDe,
        purposes: picked.purposes,
        privacyPolicyUrl: picked.privacyPolicyUrl,
      },
      fields:
        field && field.type === 'CONSENT'
          ? {
              ...spec.fields,
              [consent.fieldId]: { ...field, consentVersionId: picked.consentVersionId },
            }
          : spec.fields,
    });
  };

  const consentFields = Object.values(spec.fields).filter((field) => field.type === 'CONSENT');

  return (
    <div className="flex flex-col gap-8">
      <Section
        heading="Einwilligung"
        headingLevel={3}
        description="Der Text ist Teil einer versionierten Einwilligung und kann hier nicht umformuliert werden — nur ausgewählt."
      >
        <div className="flex flex-col gap-4">
          <SelectControl
            label="Einwilligungstext"
            value={consent.consentVersionId}
            disabled={disabled || consentTexts.length === 0}
            hint={
              consentTexts.length === 0
                ? 'Es steht noch keine freigegebene Einwilligungsversion zur Auswahl.'
                : 'Die Auswahl setzt Text, Zwecke und Datenschutz-Link gemeinsam.'
            }
            options={
              consentTexts.length === 0
                ? [{ value: consent.consentVersionId, labelDe: 'Aktuell hinterlegte Version' }]
                : consentTexts.map((entry) => ({
                    value: entry.consentVersionId,
                    labelDe: entry.labelDe,
                  }))
            }
            onChange={pickConsentText}
          />

          <div className="rounded-md border border-border bg-surface-sunken p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Wortlaut
            </p>
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground">
              {consent.textDe}
            </p>
          </div>

          <SelectControl
            label="Einwilligungsfeld im Formular"
            value={consent.fieldId}
            disabled={disabled}
            hint="Das Kästchen, an dem der Text erscheint. Es startet immer leer."
            options={
              consentFields.length === 0
                ? [{ value: consent.fieldId, labelDe: `${consent.fieldId} (fehlt im Formular)` }]
                : consentFields.map((field) => ({
                    value: field.fieldId,
                    labelDe: `${field.label} (${field.fieldId})`,
                  }))
            }
            onChange={(fieldId) => onSpecChange({ ...spec, consent: { ...consent, fieldId } })}
          />

          <CheckboxGroupControl<ConsentPurpose>
            label="Zwecke"
            hint="Nur Zwecke, die im Text tatsächlich genannt werden."
            values={consent.purposes}
            disabled
            options={CONSENT_PURPOSES.map((purpose) => ({
              value: purpose,
              labelDe: PURPOSE_LABELS_DE[purpose],
            }))}
            onChange={() => undefined}
          />

          <Alert tone="info">
            <AlertTitle>Vorangekreuzt ist keine Einwilligung</AlertTitle>
            <AlertDescription>
              Pflicht und leerer Startzustand sind fest im Schema verankert und lassen sich hier
              nicht abschalten.
            </AlertDescription>
          </Alert>

          <InlineIssues issues={consentIssues} />
        </div>
      </Section>

      <Section
        heading="Absenden"
        headingLevel={3}
        description="Beschriftungen, Schutz vor automatisierten Einsendungen und die Fehlermeldung."
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextControl
              label="Beschriftung der Absende-Schaltfläche"
              value={submit.submitLabel}
              maxLength={60}
              disabled={disabled}
              onChange={(submitLabel) =>
                onSpecChange({ ...spec, submit: { ...submit, submitLabel } })
              }
            />
            <TextControl
              label="Beschriftung während des Absendens"
              value={submit.submittingLabel}
              maxLength={60}
              disabled={disabled}
              onChange={(submittingLabel) =>
                onSpecChange({ ...spec, submit: { ...submit, submittingLabel } })
              }
            />
          </div>
          <TextareaControl
            label="Fehlermeldung beim Absenden"
            value={submit.errorMessage}
            maxLength={300}
            rows={2}
            disabled={disabled}
            onChange={(errorMessage) =>
              onSpecChange({ ...spec, submit: { ...submit, errorMessage } })
            }
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberControl
              label="Mindestdauer bis zum Absenden (Sekunden)"
              hint="Einsendungen, die schneller ankommen, gelten als automatisiert."
              value={submit.minCompletionSeconds}
              min={0}
              max={600}
              disabled={disabled}
              onChange={(minCompletionSeconds) =>
                onSpecChange({ ...spec, submit: { ...submit, minCompletionSeconds } })
              }
            />
            <NumberControl
              label="Höchstzahl Versuche pro Stunde"
              value={submit.maxAttemptsPerHour}
              min={1}
              max={100}
              disabled={disabled}
              onChange={(maxAttemptsPerHour) =>
                onSpecChange({ ...spec, submit: { ...submit, maxAttemptsPerHour } })
              }
            />
          </div>
          <SwitchControl
            label="Double-Opt-In verlangen"
            hint="Die Anfrage gilt erst nach Bestätigung des Links in der E-Mail als eingegangen."
            checked={submit.requireDoubleOptIn}
            disabled={disabled}
            onChange={(requireDoubleOptIn) =>
              onSpecChange({ ...spec, submit: { ...submit, requireDoubleOptIn } })
            }
          />
        </div>
      </Section>

      <Section
        heading="Nach dem Absenden"
        headingLevel={3}
        description="Der Zustand direkt nach einer erfolgreichen Einsendung — unabhängig von den Ergebnisseiten der Verzweigungen."
      >
        <div className="flex flex-col gap-4">
          <TextControl
            label="Überschrift"
            value={success.headline}
            maxLength={200}
            disabled={disabled}
            onChange={(headline) =>
              onSpecChange({ ...spec, success: { ...success, headline } })
            }
          />
          <TextareaControl
            label="Fließtext"
            value={success.body}
            maxLength={2000}
            rows={3}
            disabled={disabled}
            onChange={(body) => onSpecChange({ ...spec, success: { ...success, body } })}
          />
          <StringListControl
            label="Stichpunkte"
            itemNounDe="Stichpunkt"
            values={success.bullets}
            disabled={disabled}
            onChange={(bullets) => onSpecChange({ ...spec, success: { ...success, bullets } })}
          />
          <SwitchControl
            label="Zusammenfassung der Antworten zeigen"
            checked={success.showAnswerSummary}
            disabled={disabled}
            onChange={(showAnswerSummary) =>
              onSpecChange({ ...spec, success: { ...success, showAnswerSummary } })
            }
          />
          <OptionalCtaEditor
            labelDe="Hauptschaltfläche"
            cta={success.primaryCta}
            disabled={disabled}
            onChange={(primaryCta) =>
              onSpecChange({ ...spec, success: { ...success, primaryCta } })
            }
          />
          <OptionalBookingEditor
            labelDe="Terminbuchung nach dem Absenden"
            booking={success.booking}
            disabled={disabled}
            onChange={(booking) => onSpecChange({ ...spec, success: { ...success, booking } })}
          />
          <OptionalTextControl
            label="Rechtlicher Hinweis"
            value={success.legalNote}
            maxLength={600}
            disabled={disabled}
            onChange={(legalNote) =>
              onSpecChange({ ...spec, success: { ...success, legalNote } })
            }
          />
        </div>
      </Section>
    </div>
  );
}
