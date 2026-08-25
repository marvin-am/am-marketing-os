'use client';

import * as React from 'react';
import { Alert, AlertDescription, AlertTitle, Button, FormFieldRow, Input, Section } from '@am/ui';
import type { ActionResult } from '@/lib/action-result';
import type { BrandTokens, SettingsSnapshot } from '@/server/ops-port';
import { ActionFeedback, useAction } from '@/components/integrations/action-feedback';
import { PermissionGate } from './permission-gate';

/**
 * Brand tokens.
 *
 * These four colours are the only place a brand colour is defined. Components
 * never hard-code a colour, which is what lets the creative renderer and the
 * funnel runtime pick up a change without a redeploy — and what makes the
 * contrast check meaningful.
 */

const TOKENS = [
  { key: 'primary', labelDe: 'Primärfarbe', helpDe: 'Buttons, Hervorhebungen, Akzentflächen.' },
  { key: 'foreground', labelDe: 'Schriftfarbe', helpDe: 'Fließtext auf hellem Grund.' },
  { key: 'background', labelDe: 'Hintergrund', helpDe: 'Grundfläche von Creatives und Funnels.' },
  { key: 'accent', labelDe: 'Akzent', helpDe: 'Zweitfarbe für Flächen und Rahmen.' },
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface BrandPanelProps {
  snapshot: SettingsSnapshot;
  canManage: boolean;
  onSave: (input: { brand: BrandTokens }) => Promise<ActionResult<SettingsSnapshot>>;
  onChanged: (snapshot: SettingsSnapshot) => void;
}

export function BrandPanel({ snapshot, canManage, onSave, onChanged }: BrandPanelProps) {
  const [draft, setDraft] = React.useState<BrandTokens>(snapshot.brand);
  const save = useAction(onSave);

  React.useEffect(() => {
    setDraft(snapshot.brand);
  }, [snapshot.brand]);

  const invalid = TOKENS.filter((token) => !HEX.test(draft[token.key]));

  return (
    <Section
      id="brand"
      heading="Marken-Tokens"
      description="Farben werden nirgends fest verdrahtet. Alles, was Creatives und Funnels rendern, liest diese vier Werte."
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          {TOKENS.map((token) => (
            <FormFieldRow
              key={token.key}
              label={token.labelDe}
              help={token.helpDe}
              error={
                HEX.test(draft[token.key])
                  ? null
                  : 'Bitte einen Hex-Wert im Format #RRGGBB eingeben.'
              }
            >
              {({ id, describedBy, invalid: isInvalid }) => (
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    data-token-preview={token.key}
                    className="size-9 shrink-0 rounded-md border border-border"
                    style={{
                      backgroundColor: HEX.test(draft[token.key])
                        ? draft[token.key]
                        : 'transparent',
                    }}
                  />
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={isInvalid}
                    disabled={!canManage}
                    className="font-mono"
                    value={draft[token.key]}
                    onChange={(event) =>
                      setDraft({ ...draft, [token.key]: event.target.value } as BrandTokens)
                    }
                  />
                </span>
              )}
            </FormFieldRow>
          ))}
        </div>

        <FormFieldRow
          label="Pfad zum Logo"
          help="Speicherpfad im Storage-Bucket. Leer lassen, solange kein Logo hinterlegt ist."
        >
          {({ id }) => (
            <Input
              id={id}
              disabled={!canManage}
              placeholder="nicht hinterlegt"
              value={draft.logoAssetPath ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  logoAssetPath: event.target.value.trim() === '' ? null : event.target.value,
                })
              }
            />
          )}
        </FormFieldRow>

        <Alert tone="info">
          <AlertTitle>Kontrast wird beim Rendern geprüft.</AlertTitle>
          <AlertDescription>
            Eine Kombination aus Schrift- und Hintergrundfarbe, die den Kontrastanforderungen nicht
            genügt, wird beim Erzeugen eines Creatives abgelehnt — nicht stillschweigend
            ausgeliefert.
          </AlertDescription>
        </Alert>

        <ActionFeedback
          result={save.result}
          successTitleDe="Marken-Tokens gespeichert."
          successDescriptionDe="Neu erzeugte Creatives und Funnels verwenden die neuen Werte."
        />

        <PermissionGate
          permission="settings.manage"
          allowed={canManage}
          actionLabelDe="Marken-Tokens ändern"
        >
          <Button
            className="self-start"
            disabled={invalid.length > 0}
            loading={save.pending}
            onClick={async () => {
              const result = await save.run({ brand: draft });
              if (result.status === 'ok') onChanged(result.data);
            }}
          >
            Tokens speichern
          </Button>
        </PermissionGate>
      </div>
    </Section>
  );
}
