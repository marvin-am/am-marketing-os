import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  hasBlockingIssues,
  routingRuleSchema,
  validateFormSpec,
  POTENZIALANALYSE_FORM_SPEC,
  type MultiStepFormSpec,
} from '@am/funnel-schema';
import { actionOk } from '@/lib/action-result';
import type { FormBuilderCommands } from '../port';
import { FormBuilder } from './form-builder';
import { addOption, addRoutingRule, updateOption } from './form-ops';

/**
 * The behaviours that decide whether an operator can actually run this builder
 * without touching JSON: adding structure, reordering without a mouse, frozen
 * answer ids, rule building, dangling references and the save gate.
 */

/* Radix marks the body `pointer-events: none` while a modal layer is open; the
   guard would reject clicks a real user makes without trouble. */
function setupUser() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

function makeCommands(): FormBuilderCommands {
  return {
    save: vi.fn(async () => actionOk({ versionId: 'entwurf', version: 2 })),
    publish: vi.fn(async () => actionOk({ versionId: 'entwurf' })),
    duplicate: vi.fn(async () => actionOk({ versionId: 'kopie', version: 3 })),
    restore: vi.fn(async () => actionOk({ versionId: 'wiederhergestellt', version: 4 })),
  };
}

function renderBuilder(
  overrides: Partial<React.ComponentProps<typeof FormBuilder>> = {},
): { commands: FormBuilderCommands; onOpenVersion: ReturnType<typeof vi.fn> } {
  const commands = overrides.commands ?? makeCommands();
  const onOpenVersion = vi.fn();
  render(
    <FormBuilder
      initialSpec={POTENZIALANALYSE_FORM_SPEC}
      version={2}
      published={false}
      versions={[]}
      consentTexts={[]}
      commands={commands}
      onOpenVersion={onOpenVersion}
      {...overrides}
    />,
  );
  return { commands, onOpenVersion };
}

const nav = () => screen.getByRole('navigation', { name: 'Struktur des Formulars' });
const editor = () => screen.getByRole('region', { name: 'Bearbeiten' });
const summary = () => screen.getByTestId('issue-summary');

describe('FormBuilder — Struktur', () => {
  it('fügt einen Schritt und ein Feld hinzu, ohne die Gültigkeit zu verlieren', async () => {
    const user = setupUser();
    renderBuilder();

    expect(summary()).toHaveTextContent('Keine offenen Hinweise');

    await user.click(within(nav()).getByRole('button', { name: 'Schritt hinzufügen' }));
    expect(within(nav()).getByRole('button', { name: /2\. Neue Frage/ })).toBeInTheDocument();

    await user.click(within(editor()).getByRole('button', { name: 'Feld hinzufügen' }));
    expect(within(editor()).getByRole('button', { name: 'Neue Auswahlfrage' })).toBeInTheDocument();

    /* The validator runs on every keystroke; a clean summary means the document
       the builder produced still parses and still passes every graph rule. */
    expect(summary()).toHaveTextContent('Keine offenen Hinweise');
    expect(screen.getByRole('button', { name: 'Entwurf speichern' })).toBeEnabled();
  });

  it('sortiert Schritte allein mit der Tastatur um', async () => {
    const user = setupUser();
    renderBuilder();

    const second = POTENZIALANALYSE_FORM_SPEC.steps[1]!;
    const moveUp = within(nav()).getByRole('button', {
      name: `Schritt ${second.title} nach oben verschieben`,
    });

    moveUp.focus();
    expect(moveUp).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(within(nav()).getByTestId(`orderable-item-${second.stepId}`)).toHaveAttribute(
      'data-position',
      '1',
    );
    expect(
      within(nav()).getByTestId(`orderable-item-${POTENZIALANALYSE_FORM_SPEC.steps[0]!.stepId}`),
    ).toHaveAttribute('data-position', '2');
  });

  it('meldet einen Verweis ins Leere, wenn ein Ziel-Schritt gelöscht wird', async () => {
    const user = setupUser();
    renderBuilder();

    const target = POTENZIALANALYSE_FORM_SPEC.steps[1]!;
    await user.click(
      within(nav()).getByRole('button', { name: `Schritt „${target.title}“ löschen` }),
    );

    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Schritt löschen' }));

    expect(summary()).toHaveTextContent(`unbekannten Schritt „${target.stepId}“`);
    expect(screen.getByRole('button', { name: 'Entwurf speichern' })).toBeDisabled();
  });
});

describe('FormBuilder — Antwortoptionen', () => {
  it('leitet die Antwort-Kennung aus der Beschriftung ab und friert sie danach ein', async () => {
    const user = setupUser();
    renderBuilder();

    const field = POTENZIALANALYSE_FORM_SPEC.fields.rolle!;
    await user.click(within(editor()).getByRole('button', { name: field.label }));
    await user.click(within(editor()).getByRole('button', { name: 'Antwort hinzufügen' }));

    const row = within(editor()).getByTestId('orderable-item-neue_antwort');
    expect(within(row).getByText('neue_antwort')).toBeInTheDocument();

    const labelInput = within(row).getByLabelText('Sichtbare Beschriftung');
    await user.clear(labelInput);
    await user.type(labelInput, 'Ganz andere Rolle');

    const renamed = within(editor()).getByTestId('orderable-item-neue_antwort');
    expect(within(renamed).getByLabelText('Sichtbare Beschriftung')).toHaveValue(
      'Ganz andere Rolle',
    );
    /* The id is rendered as text, never as an input: it cannot follow the label. */
    expect(within(renamed).getByText('neue_antwort')).toBeInTheDocument();
    expect(within(editor()).queryByLabelText('Antwort-Kennung')).not.toBeInTheDocument();
  });

  it('behält die Kennung auch nach einer Umbenennung im Dokument', () => {
    const added = addOption(POTENZIALANALYSE_FORM_SPEC, 'rolle', 'Externe Beratung');
    expect(added.optionId).toBe('externe_beratung');

    const renamed = updateOption(added.spec, 'rolle', added.optionId, {
      label: 'Vollkommen andere Beschriftung',
    });
    const option = renamed.fields.rolle?.type === 'SINGLE_SELECT'
      ? renamed.fields.rolle.options.find((entry) => entry.optionId === added.optionId)
      : undefined;

    expect(option?.optionId).toBe('externe_beratung');
    expect(option?.label).toBe('Vollkommen andere Beschriftung');
  });
});

describe('FormBuilder — Verzweigungen', () => {
  it('erzeugt aus dem Bedingungsbaukasten eine gültige Routing-Regel', () => {
    const { spec, ruleId } = addRoutingRule(POTENZIALANALYSE_FORM_SPEC, 'frage_2');
    const rule = spec.routingRules.find((entry) => entry.ruleId === ruleId);

    expect(routingRuleSchema.safeParse(rule).success).toBe(true);
    expect(hasBlockingIssues(validateFormSpec(spec))).toBe(false);
  });

  it('macht einen Kreis in der Schrittfolge als blockierenden Fehler sichtbar', async () => {
    const user = setupUser();
    renderBuilder();

    const second = POTENZIALANALYSE_FORM_SPEC.steps[1]!;
    const first = POTENZIALANALYSE_FORM_SPEC.steps[0]!;

    await user.click(within(nav()).getByRole('button', { name: `2. ${second.title}` }));
    await user.click(within(editor()).getByRole('button', { name: 'Regel hinzufügen' }));

    const ruleRow = within(editor()).getByTestId(`orderable-item-regel_${second.stepId}`);
    await user.selectOptions(within(ruleRow).getByLabelText('Zielschritt'), first.stepId);

    expect(summary()).toHaveTextContent('enthält einen Kreis');
    expect(screen.getByRole('button', { name: 'Entwurf speichern' })).toBeDisabled();
  });
});

describe('FormBuilder — Speichern und Veröffentlichen', () => {
  it('sperrt das Speichern, solange die Spezifikation einen Fehler enthält', () => {
    const broken: MultiStepFormSpec = {
      ...POTENZIALANALYSE_FORM_SPEC,
      steps: POTENZIALANALYSE_FORM_SPEC.steps.map((step) =>
        step.stepId === 'standort'
          ? { ...step, defaultNext: { kind: 'STEP' as const, stepId: 'gibt_es_nicht' } }
          : step,
      ),
    };

    renderBuilder({ initialSpec: broken });

    expect(summary()).toHaveTextContent('Fehler verhindern das Speichern');
    expect(screen.getByRole('button', { name: 'Entwurf speichern' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Veröffentlichen' })).toBeDisabled();
  });

  it('speichert einen geänderten Entwurf und meldet den Erfolg auf Deutsch', async () => {
    const user = setupUser();
    const { commands } = renderBuilder();

    await user.click(within(nav()).getByRole('button', { name: 'Schritt hinzufügen' }));

    const save = screen.getByRole('button', { name: 'Entwurf speichern' });
    expect(save).toBeEnabled();
    await user.click(save);

    expect(commands.save).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Entwurf 2 gespeichert.')).toBeInTheDocument();
  });

  it('öffnet eine veröffentlichte Version schreibgeschützt mit deutscher Erklärung', () => {
    renderBuilder({ published: true });

    expect(screen.getByText('Veröffentlichte Version — schreibgeschützt')).toBeInTheDocument();
    expect(screen.getByText(/unveränderlich/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Entwurf speichern' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Veröffentlichen' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Als neuen Entwurf bearbeiten' }),
    ).toBeEnabled();
    expect(within(nav()).getByRole('button', { name: 'Schritt hinzufügen' })).toBeDisabled();
    expect(within(editor()).getByLabelText('Überschrift')).toBeDisabled();
  });

  it('erzeugt beim Bearbeiten einer veröffentlichten Version einen neuen Entwurf', async () => {
    const user = setupUser();
    const commands = makeCommands();
    const onOpenVersion = vi.fn();

    render(
      <FormBuilder
        initialSpec={POTENZIALANALYSE_FORM_SPEC}
        version={1}
        published
        versions={[]}
        consentTexts={[]}
        commands={commands}
        onOpenVersion={onOpenVersion}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Als neuen Entwurf bearbeiten' }));

    expect(commands.duplicate).toHaveBeenCalledTimes(1);
    expect(onOpenVersion).toHaveBeenCalledWith('kopie');
    expect(await screen.findByText('Neue Entwurfsversion 3 erstellt.')).toBeInTheDocument();
  });
});
