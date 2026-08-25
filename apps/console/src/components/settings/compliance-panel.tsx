'use client';

import * as React from 'react';
import type { ConsentPurpose, RetentionPolicy } from '@am/domain';
import { CONSENT_PURPOSES } from '@am/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  CheckboxField,
  ConfirmDialog,
  FormFieldRow,
  Input,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@am/ui';
import type { ActionResult } from '@/lib/action-result';
import { formatDate, formatNumber } from '@/lib/format';
import type { SaveConsentVersionInput, SettingsSnapshot } from '@/server/ops-port';
import { ActionFeedback, useAction } from '@/components/integrations/action-feedback';
import { PermissionGate } from './permission-gate';

/**
 * Consent versions and the retention policy.
 *
 * Two rules that are not negotiable and are therefore built into the UI rather
 * than left to discipline:
 *
 * 1. **A consent text is never edited.** What was stored is the exact wording a
 *    visitor saw. Changing it creates a new version; the old one keeps its text
 *    and gets an end date (spec §28).
 * 2. **No retention period is invented.** Every field defaults to „nicht
 *    konfiguriert“, and the panel says plainly that nothing is deleted
 *    automatically until the responsible party sets a period. Guessing a legal
 *    period would be worse than leaving it empty.
 */

const PURPOSE_LABELS_DE: Readonly<Record<ConsentPurpose, string>> = {
  CONTACT: 'Kontaktaufnahme',
  MARKETING_EMAIL: 'Marketing-E-Mails',
  ANALYTICS: 'Analyse',
  AD_MEASUREMENT: 'Anzeigenmessung',
};

const RETENTION_FIELDS = [
  {
    key: 'submissionPiiDays',
    labelDe: 'Personenbezogene Formulardaten',
    helpDe: 'Name, E-Mail, Telefon aus Formularabsendungen.',
  },
  {
    key: 'rawProviderPayloadDays',
    labelDe: 'Rohantworten der Anbieter',
    helpDe: 'Bereits redigierte Provider-Antworten in der Outbox.',
  },
  {
    key: 'analyticsEventDays',
    labelDe: 'Analyse-Ereignisse',
    helpDe: 'Sitzungs- und Interaktionsereignisse ohne Personenbezug.',
  },
  {
    key: 'auditLogDays',
    labelDe: 'Audit-Log',
    helpDe: 'Wer hat wann was geändert.',
  },
] as const;

type RetentionKey = (typeof RETENTION_FIELDS)[number]['key'];

export interface CompliancePanelProps {
  snapshot: SettingsSnapshot;
  canManage: boolean;
  onAddConsentVersion: (
    input: SaveConsentVersionInput,
  ) => Promise<ActionResult<SettingsSnapshot>>;
  onSaveRetention: (input: {
    policy: Omit<RetentionPolicy, 'configuredBy' | 'configuredAt'>;
  }) => Promise<ActionResult<SettingsSnapshot>>;
  onChanged: (snapshot: SettingsSnapshot) => void;
}

export function CompliancePanel({
  snapshot,
  canManage,
  onAddConsentVersion,
  onSaveRetention,
  onChanged,
}: CompliancePanelProps) {
  return (
    <div className="flex flex-col gap-8">
      <ConsentSection
        snapshot={snapshot}
        canManage={canManage}
        onAddConsentVersion={onAddConsentVersion}
        onChanged={onChanged}
      />
      <RetentionSection
        snapshot={snapshot}
        canManage={canManage}
        onSaveRetention={onSaveRetention}
        onChanged={onChanged}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Consent                                                                     */
/* -------------------------------------------------------------------------- */

function ConsentSection({
  snapshot,
  canManage,
  onAddConsentVersion,
  onChanged,
}: Omit<CompliancePanelProps, 'onSaveRetention'>) {
  const [textDe, setTextDe] = React.useState('');
  const [purposes, setPurposes] = React.useState<ConsentPurpose[]>(['CONTACT']);
  const [url, setUrl] = React.useState(
    snapshot.consentVersions.at(-1)?.privacyPolicyUrl ?? '',
  );
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const add = useAction(onAddConsentVersion);

  const current = snapshot.consentVersions.filter((version) => version.effectiveUntil === null);
  const nextVersion = (snapshot.consentVersions.at(-1)?.version ?? 0) + 1;
  const valid = textDe.trim().length >= 20 && purposes.length > 0 && url.trim().length > 0;

  return (
    <Section
      id="consent"
      heading="Einwilligungen"
      description="Der Text, den eine Besucherin gesehen hat, wird wortgetreu gespeichert. Eine Änderung erzeugt immer eine neue Version — bestehende Versionen bleiben unverändert."
    >
      <div className="flex flex-col gap-4">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Gültig ab</TableHead>
                <TableHead>Gültig bis</TableHead>
                <TableHead>Zwecke</TableHead>
                <TableHead>Text</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.consentVersions.map((version) => (
                <TableRow key={version.id} data-consent-version={version.version}>
                  <TableCell className="tabular-nums">v{version.version}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(version.effectiveFrom)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {version.effectiveUntil ? (
                      formatDate(version.effectiveUntil)
                    ) : (
                      <Badge tone="success" size="sm">
                        aktuell
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {version.purposes.map((purpose) => (
                        <Badge key={purpose} tone="outline" size="sm">
                          {PURPOSE_LABELS_DE[purpose]}
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-md text-xs leading-relaxed text-muted-foreground">
                    {version.textDe}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {current.length === 0 ? (
          <Alert tone="warning">
            <AlertTitle>Es ist keine aktuelle Einwilligungsversion hinterlegt.</AlertTitle>
            <AlertDescription>
              Ohne gültigen Text kann kein Formular veröffentlicht werden.
            </AlertDescription>
          </Alert>
        ) : null}

        <ActionFeedback
          result={add.result}
          successTitleDe="Neue Einwilligungsversion angelegt."
          successDescriptionDe="Die vorherige Version wurde beendet und bleibt unverändert erhalten."
        />

        <PermissionGate
          permission="settings.manage"
          allowed={canManage}
          actionLabelDe="Einwilligungstext ändern"
        >
          <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium text-foreground">
              Neue Version {nextVersion} anlegen
            </legend>
            <FormFieldRow
              label="Einwilligungstext"
              required
              help="Mindestens 20 Zeichen. Der Text wird wortgetreu gespeichert und kann danach nicht mehr geändert werden."
            >
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  rows={4}
                  value={textDe}
                  onChange={(event) => setTextDe(event.target.value)}
                />
              )}
            </FormFieldRow>

            <FormFieldRow label="Link zur Datenschutzerklärung" required>
              {({ id }) => (
                <Input id={id} value={url} onChange={(event) => setUrl(event.target.value)} />
              )}
            </FormFieldRow>

            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium text-foreground">Zwecke</legend>
              {CONSENT_PURPOSES.map((purpose) => (
                <CheckboxField
                  key={purpose}
                  label={PURPOSE_LABELS_DE[purpose]}
                  checked={purposes.includes(purpose)}
                  onCheckedChange={(next) =>
                    setPurposes((current2) =>
                      next === true
                        ? [...current2, purpose]
                        : current2.filter((entry) => entry !== purpose),
                    )
                  }
                />
              ))}
            </fieldset>

            <Button
              className="self-start"
              disabled={!valid}
              loading={add.pending}
              onClick={() => setConfirmOpen(true)}
            >
              Neue Version anlegen
            </Button>
          </fieldset>
        </PermissionGate>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Einwilligungsversion ${nextVersion} anlegen`}
        description="Die bisher gültige Version wird beendet und bleibt unverändert erhalten. Die neue Version gilt ab sofort für alle Formulare."
        preview={
          <div className="flex flex-col gap-2 text-sm">
            <p className="whitespace-pre-wrap leading-relaxed">{textDe}</p>
            <p className="text-xs text-muted-foreground">
              Zwecke: {purposes.map((purpose) => PURPOSE_LABELS_DE[purpose]).join(', ')} ·
              Datenschutzerklärung: {url}
            </p>
          </div>
        }
        confirmLabel="Version anlegen"
        tone="primary"
        pending={add.pending}
        onConfirm={async () => {
          const result = await add.run({ textDe, purposes, privacyPolicyUrl: url });
          if (result.status === 'ok') {
            onChanged(result.data);
            setTextDe('');
          }
          setConfirmOpen(false);
        }}
      />
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

function RetentionSection({
  snapshot,
  canManage,
  onSaveRetention,
  onChanged,
}: Omit<CompliancePanelProps, 'onAddConsentVersion'>) {
  const [values, setValues] = React.useState<Record<RetentionKey, string>>({
    submissionPiiDays: toInput(snapshot.retention.submissionPiiDays),
    rawProviderPayloadDays: toInput(snapshot.retention.rawProviderPayloadDays),
    analyticsEventDays: toInput(snapshot.retention.analyticsEventDays),
    auditLogDays: toInput(snapshot.retention.auditLogDays),
  });
  const save = useAction(onSaveRetention);

  const configured = RETENTION_FIELDS.some(
    (field) => snapshot.retention[field.key] !== null,
  );

  return (
    <Section
      id="retention"
      heading="Aufbewahrung und Löschung"
      description="Wie lange welche Daten aufbewahrt werden. Bewusst ohne Vorbelegung."
    >
      <div className="flex flex-col gap-4">
        <Alert tone={configured ? 'info' : 'warning'} data-retention-configured={configured}>
          <AlertTitle>
            {configured
              ? 'Aufbewahrungsfristen sind teilweise oder vollständig konfiguriert.'
              : 'Es ist keine Aufbewahrungsfrist konfiguriert.'}
          </AlertTitle>
          <AlertDescription>
            {configured
              ? 'Nicht gesetzte Felder werden weiterhin nicht automatisch gelöscht.'
              : 'Es wird nichts automatisch gelöscht. Das Produkt setzt hier bewusst keine Frist ein: Welche gesetzliche Aufbewahrungsdauer gilt, entscheidet die verantwortliche Stelle — eine erfundene Frist wäre gefährlicher als gar keine.'}
          </AlertDescription>
        </Alert>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datenart</TableHead>
                <TableHead>Aktuelle Frist</TableHead>
                <TableHead>Neue Frist in Tagen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {RETENTION_FIELDS.map((field) => {
                const value = snapshot.retention[field.key];
                return (
                  <TableRow key={field.key} data-retention-field={field.key}>
                    <TableCell>
                      <span className="block font-medium">{field.labelDe}</span>
                      <span className="block text-xs text-muted-foreground">{field.helpDe}</span>
                    </TableCell>
                    <TableCell>
                      {value === null ? (
                        <Badge tone="warning" size="sm">
                          nicht konfiguriert
                        </Badge>
                      ) : (
                        <span className="tabular-nums">{formatNumber(value)} Tage</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <PermissionGate
                        permission="settings.manage"
                        allowed={canManage}
                        actionLabelDe="Aufbewahrungsfrist ändern"
                      >
                        <Input
                          type="number"
                          min={1}
                          aria-label={`${field.labelDe} in Tagen`}
                          placeholder="nicht konfiguriert"
                          value={values[field.key]}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                          }
                        />
                      </PermissionGate>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <ActionFeedback
          result={save.result}
          successTitleDe="Aufbewahrungsfristen gespeichert."
          successDescriptionDe="Leere Felder bleiben „nicht konfiguriert“ und werden nicht automatisch gelöscht."
        />

        <PermissionGate
          permission="settings.manage"
          allowed={canManage}
          actionLabelDe="Aufbewahrungsfristen speichern"
        >
          <Button
            className="self-start"
            loading={save.pending}
            onClick={async () => {
              const result = await save.run({
                policy: {
                  submissionPiiDays: toDays(values.submissionPiiDays),
                  rawProviderPayloadDays: toDays(values.rawProviderPayloadDays),
                  analyticsEventDays: toDays(values.analyticsEventDays),
                  auditLogDays: toDays(values.auditLogDays),
                },
              });
              if (result.status === 'ok') onChanged(result.data);
            }}
          >
            Fristen speichern
          </Button>
        </PermissionGate>
      </div>
    </Section>
  );
}

function toInput(value: number | null): string {
  return value === null ? '' : String(value);
}

function toDays(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
