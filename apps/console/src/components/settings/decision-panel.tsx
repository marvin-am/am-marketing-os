'use client';

import * as React from 'react';
import {
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  DEFAULT_EXPERIMENT_THRESHOLDS,
  DEFAULT_RECOMMENDATION_CONFIG,
  type ExperimentThresholds,
  type RecommendationConfig,
} from '@am/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  CheckboxField,
  FormFieldRow,
  Input,
  Section,
} from '@am/ui';
import type { ActionResult } from '@/lib/action-result';
import { formatNumber } from '@/lib/format';
import type { SettingsSnapshot } from '@/server/ops-port';
import { ActionFeedback, useAction } from '@/components/integrations/action-feedback';
import { PermissionGate } from './permission-gate';

/**
 * The numbers the decision engine reads.
 *
 * These are configuration, not constants: the statistics engine and the rules
 * engine always read the persisted values, and the defaults from `@am/domain`
 * are only the starting point. Each field is shown together with its default,
 * so an accidental edit is visible rather than silent.
 */

interface NumberFieldSpec<T> {
  key: keyof T & string;
  labelDe: string;
  helpDe: string;
  /** Value shown and entered as a percentage of the stored fraction. */
  percent?: boolean;
  step?: number;
  min?: number;
}

const EXPERIMENT_FIELDS: readonly NumberFieldSpec<ExperimentThresholds>[] = [
  { key: 'minRuntimeDays', labelDe: 'Mindestlaufzeit (Tage)', helpDe: 'Vorher wird nie ein Gewinner ausgerufen.', min: 1 },
  { key: 'maxRuntimeDays', labelDe: 'Höchstlaufzeit (Tage)', helpDe: 'Danach wird das Experiment zur Entscheidung vorgelegt.', min: 1 },
  { key: 'minSessionsPerArm', labelDe: 'Mindestsitzungen je Arm', helpDe: 'Untergrenze der Stichprobe pro Variante.', min: 1 },
  { key: 'minConversionsPerArm', labelDe: 'Mindest-Conversions je Arm', helpDe: 'Ohne genügend Conversions bleibt jedes Ergebnis Rauschen.', min: 1 },
  {
    key: 'minWinProbability',
    labelDe: 'Nötige Gewinnwahrscheinlichkeit (%)',
    helpDe: 'Posteriore Wahrscheinlichkeit, ab der ein Arm als Gewinner gilt.',
    percent: true,
  },
  {
    key: 'minRelativeLift',
    labelDe: 'Praktisch relevanter Unterschied (%)',
    helpDe: 'Kleinere Unterschiede werden als „kein Unterschied“ behandelt.',
    percent: true,
  },
  {
    key: 'crmMaturityDays',
    labelDe: 'Reifezeit der CRM-Kohorte (Tage)',
    helpDe: 'So lange muss eine Kohorte altern, bevor ihre Abschlüsse als belastbar gelten.',
    min: 0,
  },
];

const RECOMMENDATION_FIELDS: readonly NumberFieldSpec<RecommendationConfig>[] = [
  {
    key: 'noLeadSpendMultiple',
    labelDe: 'Pausierungswarnung ab Vielfachem des Ziel-CPL',
    helpDe: 'Ausgaben ohne einen einzigen Lead, gemessen am Ziel-Cost-per-Lead.',
    step: 0.1,
  },
  {
    key: 'noQualifiedVqSpendMultiple',
    labelDe: 'Warnung ab Vielfachem der Zielkosten je qualifizierter VQ',
    helpDe: 'Ausgaben ohne qualifizierte Qualifizierung.',
    step: 0.1,
  },
  {
    key: 'scaleStepPct',
    labelDe: 'Standard-Skalierungsschritt (%)',
    helpDe: 'Vorgeschlagene Budgeterhöhung je Aktion.',
    percent: true,
  },
  {
    key: 'scaleCooldownHours',
    labelDe: 'Abkühlzeit zwischen Skalierungen (Stunden)',
    helpDe: 'Mindestabstand zweier Skalierungen auf demselben Objekt.',
    min: 0,
  },
  {
    key: 'minLeadsForLeadingSignals',
    labelDe: 'Mindestleads für Frühindikatoren',
    helpDe: 'Darunter wird keine Empfehlung aus vorlaufenden Kennzahlen erzeugt.',
    min: 0,
  },
];

export interface DecisionPanelProps {
  snapshot: SettingsSnapshot;
  canManage: boolean;
  onSaveExperimentThresholds: (input: {
    thresholds: ExperimentThresholds;
  }) => Promise<ActionResult<SettingsSnapshot>>;
  onSaveRecommendationConfig: (input: {
    config: RecommendationConfig;
  }) => Promise<ActionResult<SettingsSnapshot>>;
  onSaveAttributionWindow: (input: {
    windowDays: number;
  }) => Promise<ActionResult<SettingsSnapshot>>;
  onChanged: (snapshot: SettingsSnapshot) => void;
}

export function DecisionPanel({
  snapshot,
  canManage,
  onSaveExperimentThresholds,
  onSaveRecommendationConfig,
  onSaveAttributionWindow,
  onChanged,
}: DecisionPanelProps) {
  const [thresholds, setThresholds] = React.useState<ExperimentThresholds>(
    snapshot.experimentThresholds,
  );
  const [config, setConfig] = React.useState<RecommendationConfig>(snapshot.recommendationConfig);
  const [windowDays, setWindowDays] = React.useState(snapshot.attributionWindowDays);

  React.useEffect(() => {
    setThresholds(snapshot.experimentThresholds);
    setConfig(snapshot.recommendationConfig);
    setWindowDays(snapshot.attributionWindowDays);
  }, [snapshot]);

  const saveThresholds = useAction(onSaveExperimentThresholds);
  const saveConfig = useAction(onSaveRecommendationConfig);
  const saveWindow = useAction(onSaveAttributionWindow);

  return (
    <div className="flex flex-col gap-8">
      <Section
        id="experiment-thresholds"
        heading="Experiment-Schwellen"
        description="Die Statistik liest immer diese Werte — nie die Konstanten im Code."
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {EXPERIMENT_FIELDS.map((field) => (
              <NumberField
                key={field.key}
                spec={field}
                value={thresholds[field.key]}
                defaultValue={DEFAULT_EXPERIMENT_THRESHOLDS[field.key]}
                disabled={!canManage}
                onChange={(value) => setThresholds({ ...thresholds, [field.key]: value })}
              />
            ))}
          </div>

          <ActionFeedback
            result={saveThresholds.result}
            successTitleDe="Experiment-Schwellen gespeichert."
            successDescriptionDe="Laufende Experimente werden ab der nächsten Auswertung daran gemessen."
          />

          <PermissionGate
            permission="settings.manage"
            allowed={canManage}
            actionLabelDe="Experiment-Schwellen ändern"
          >
            <Button
              className="self-start"
              loading={saveThresholds.pending}
              onClick={async () => {
                const result = await saveThresholds.run({ thresholds });
                if (result.status === 'ok') onChanged(result.data);
              }}
            >
              Schwellen speichern
            </Button>
          </PermissionGate>
        </div>
      </Section>

      <Section
        id="recommendation-config"
        heading="Empfehlungsregeln"
        description="Die Regeln sind deterministisch. Das Modell darf eine Empfehlung erklären, aber nie eine Zahl oder eine Handlung erzeugen."
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {RECOMMENDATION_FIELDS.map((field) => (
              <NumberField
                key={field.key}
                spec={field}
                value={config[field.key] as number}
                defaultValue={DEFAULT_RECOMMENDATION_CONFIG[field.key] as number}
                disabled={!canManage}
                onChange={(value) => setConfig({ ...config, [field.key]: value })}
              />
            ))}
          </div>

          <CheckboxField
            label="Skalierung erst bei reifer CRM-Kohorte erlauben"
            description="Verhindert, dass ein Budget auf Basis von Leads erhöht wird, deren Abschlüsse noch gar nicht feststehen können."
            disabled={!canManage}
            checked={config.requireMatureCrmForScale}
            onCheckedChange={(next) =>
              setConfig({ ...config, requireMatureCrmForScale: next === true })
            }
          />

          <ActionFeedback
            result={saveConfig.result}
            successTitleDe="Empfehlungsregeln gespeichert."
            successDescriptionDe="Die nächste Auswertung nutzt die neuen Schwellen."
          />

          <PermissionGate
            permission="settings.manage"
            allowed={canManage}
            actionLabelDe="Empfehlungsregeln ändern"
          >
            <Button
              className="self-start"
              loading={saveConfig.pending}
              onClick={async () => {
                const result = await saveConfig.run({ config });
                if (result.status === 'ok') onChanged(result.data);
              }}
            >
              Regeln speichern
            </Button>
          </PermissionGate>
        </div>
      </Section>

      <Section
        id="attribution"
        heading="Attributionsfenster"
        description="Wie weit zurück ein Kontaktpunkt einer Kampagne zugerechnet wird."
      >
        <div className="flex flex-col gap-4">
          <Alert tone="info">
            <AlertTitle>Bereits gespeicherte Zuordnungen ändern sich nicht.</AlertTitle>
            <AlertDescription>
              Jede Zuordnung wird beim Absenden eingefroren und trägt das Fenster, das damals galt.
              Eine Änderung hier wirkt nur auf neue Absendungen — die Zahlen vergangener Kampagnen
              bleiben, wie sie berichtet wurden.
            </AlertDescription>
          </Alert>

          <FormFieldRow
            label="Attributionsfenster (Tage)"
            help={`Standard: ${formatNumber(DEFAULT_ATTRIBUTION_WINDOW_DAYS)} Tage.`}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="number"
                min={1}
                disabled={!canManage}
                className="max-w-40"
                value={String(windowDays)}
                onChange={(event) => setWindowDays(Number(event.target.value) || 1)}
              />
            )}
          </FormFieldRow>

          <ActionFeedback
            result={saveWindow.result}
            successTitleDe="Attributionsfenster gespeichert."
            successDescriptionDe="Es gilt ab der nächsten Formularabsendung."
          />

          <PermissionGate
            permission="settings.manage"
            allowed={canManage}
            actionLabelDe="Attributionsfenster ändern"
          >
            <Button
              className="self-start"
              loading={saveWindow.pending}
              onClick={async () => {
                const result = await saveWindow.run({ windowDays });
                if (result.status === 'ok') onChanged(result.data);
              }}
            >
              Fenster speichern
            </Button>
          </PermissionGate>
        </div>
      </Section>
    </div>
  );
}

interface NumberFieldProps<T> {
  spec: NumberFieldSpec<T>;
  value: number;
  defaultValue: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

function NumberField<T>({ spec, value, defaultValue, disabled, onChange }: NumberFieldProps<T>) {
  const shown = spec.percent ? Math.round(value * 1000) / 10 : value;
  const shownDefault = spec.percent ? Math.round(defaultValue * 1000) / 10 : defaultValue;

  return (
    <FormFieldRow
      label={spec.labelDe}
      help={`${spec.helpDe} Standard: ${formatNumber(shownDefault, spec.percent || spec.step ? 1 : 0)}${
        spec.percent ? ' %' : ''
      }.`}
    >
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          type="number"
          min={spec.min}
          step={spec.percent ? 0.1 : (spec.step ?? 1)}
          disabled={disabled}
          value={String(shown)}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
            onChange(spec.percent ? next / 100 : next);
          }}
        />
      )}
    </FormFieldRow>
  );
}
