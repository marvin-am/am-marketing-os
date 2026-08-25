import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIELD_TYPES, type FieldType } from '@am/domain';
import { POTENZIALANALYSE_FORM_SPEC, type MultiStepFormSpec } from '@am/funnel-schema';
import { addFieldToStep } from '../form/form-ops';
import { FormPreview } from './form-preview';

/**
 * The preview is only worth having if walking it produces exactly what the
 * published funnel would produce. These tests walk a disqualifying branch and
 * check the landing state, the fired rule and the frame the reviewer sees it in.
 */

function setupUser() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

async function walkToDisqualification(user: ReturnType<typeof setupUser>) {
  await user.click(screen.getByRole('button', { name: 'Analyse starten' }));

  await user.click(screen.getByRole('radio', { name: /Geschäftsführung/ }));
  await user.click(screen.getByRole('button', { name: 'Weiter' }));

  await user.click(screen.getByRole('checkbox', { name: /Empfehlungen/ }));
  await user.click(screen.getByRole('button', { name: 'Weiter' }));

  await user.click(screen.getByRole('radio', { name: 'Bis zu 10' }));
  await user.click(screen.getByRole('button', { name: 'Weiter' }));

  await user.click(screen.getByRole('radio', { name: 'Unter 500 €' }));
  await user.click(screen.getByRole('button', { name: 'Weiter' }));
}

describe('FormPreview', () => {
  it('läuft eine Verzweigung durch und landet auf der erwarteten Ergebnisvariante', async () => {
    const user = setupUser();
    render(<FormPreview spec={POTENZIALANALYSE_FORM_SPEC} />);

    await walkToDisqualification(user);

    const result = screen.getByTestId('result-variant');
    expect(result).toHaveAttribute('data-variant-id', 'nicht_passend');
    expect(result).toHaveAttribute('data-variant-kind', 'NOT_A_FIT');
    expect(
      within(result).getByText('Wir sind aktuell nicht die richtige Wahl'),
    ).toBeInTheDocument();
  });

  it('zeigt im Pfad-Inspektor, welche Verzweigungsregel gegriffen hat', async () => {
    const user = setupUser();
    render(<FormPreview spec={POTENZIALANALYSE_FORM_SPEC} />);

    await walkToDisqualification(user);

    const inspector = screen.getByRole('region', { name: 'Berechneter Pfad' });
    expect(within(inspector).getByText('greift')).toBeInTheDocument();
    expect(
      within(inspector).getByText(/Bricht ab, wenn Welches monatliche Werbebudget/),
    ).toBeInTheDocument();
    expect(within(inspector).getByText('Nicht passend')).toBeInTheDocument();
    expect(within(inspector).getByTestId('selected-variant')).toHaveAttribute(
      'data-variant-id',
      'nicht_passend',
    );
  });

  it('blockiert den nächsten Schritt, solange eine Pflichtangabe fehlt', async () => {
    const user = setupUser();
    render(<FormPreview spec={POTENZIALANALYSE_FORM_SPEC} />);

    await user.click(screen.getByRole('button', { name: 'Analyse starten' }));
    await user.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Bitte füllen Sie dieses Feld aus.',
    );
    /* Still on the first question — the engine refused the transition. */
    expect(screen.getByRole('radio', { name: /Geschäftsführung/ })).toBeInTheDocument();
  });

  it('markiert jede Vorschau sichtbar als Vorschau', () => {
    render(<FormPreview spec={POTENZIALANALYSE_FORM_SPEC} noteDe="Entwurf v2" />);

    const frame = screen.getByTestId('preview-frame');
    expect(within(frame).getByText('Vorschau')).toBeInTheDocument();
    expect(
      within(frame).getByText('Vorschau — nicht die veröffentlichte Strecke'),
    ).toBeInTheDocument();
    expect(within(frame).getByText('Entwurf v2')).toBeInTheDocument();
  });

  it('rendert den Vorschaurahmen bei 320 px ohne horizontalen Überlauf', async () => {
    const user = setupUser();
    render(<FormPreview spec={POTENZIALANALYSE_FORM_SPEC} />);

    await user.click(screen.getByRole('button', { name: '320 px' }));

    const frame = screen.getByTestId('preview-frame');
    expect(frame).toHaveAttribute('data-viewport', '320');
    /* jsdom does not lay out, so the guarantee is asserted where it is made:
       a fixed 320 px box that never exceeds its pane and clips sideways. */
    expect(frame).toHaveStyle({ width: '320px', maxWidth: '100%', overflowX: 'hidden' });
  });

  it('rendert jeden der 13 Feldtypen ohne Sonderfall im Aufrufer', async () => {
    const user = setupUser();

    /* A step holds at most twelve fields, so the thirteen types are checked in
       two passes. Together they cover `FIELD_TYPES` exactly. */
    const choiceTypes: FieldType[] = [
      'SINGLE_SELECT',
      'MULTI_SELECT',
      'BOOLEAN',
      'NUMBER',
      'RANGE',
      'CONSENT',
    ];
    const textTypes: FieldType[] = [
      'SHORT_TEXT',
      'LONG_TEXT',
      'POSTCODE',
      'EMAIL',
      'PHONE',
      'FIRST_NAME',
      'LAST_NAME',
    ];
    expect([...choiceTypes, ...textTypes].sort()).toEqual([...FIELD_TYPES].sort());

    const specWith = (types: readonly FieldType[]): MultiStepFormSpec => {
      let spec: MultiStepFormSpec = {
        ...POTENZIALANALYSE_FORM_SPEC,
        steps: POTENZIALANALYSE_FORM_SPEC.steps.map((step) =>
          step.stepId === 'frage_1' ? { ...step, fieldIds: [] } : step,
        ),
      };
      for (const type of types) spec = addFieldToStep(spec, 'frage_1', type).spec;
      return spec;
    };

    const first = render(<FormPreview spec={specWith(choiceTypes)} />);
    await user.click(screen.getByRole('button', { name: 'Analyse starten' }));

    const choiceStep = screen.getByTestId('preview-frame');
    expect(within(choiceStep).getAllByRole('radio').length).toBeGreaterThanOrEqual(4);
    expect(within(choiceStep).getAllByRole('checkbox').length).toBeGreaterThanOrEqual(3);
    expect(within(choiceStep).getAllByRole('slider')).toHaveLength(1);
    expect(within(choiceStep).getAllByRole('spinbutton')).toHaveLength(1);
    expect(within(choiceStep).getByText(/Ich willige ein/)).toBeInTheDocument();
    first.unmount();

    render(<FormPreview spec={specWith(textTypes)} />);
    await user.click(screen.getByRole('button', { name: 'Analyse starten' }));

    const textStep = screen.getByTestId('preview-frame');
    expect(within(textStep).getAllByRole('textbox').length).toBeGreaterThanOrEqual(
      textTypes.length,
    );
  });

  it('bietet alle geforderten Vorschaubreiten an', () => {
    render(<FormPreview spec={POTENZIALANALYSE_FORM_SPEC} />);

    const group = screen.getByRole('group', { name: 'Vorschaubreite' });
    for (const labelDe of ['320 px', '375 px', '430 px', 'Desktop']) {
      expect(within(group).getByRole('button', { name: labelDe })).toBeInTheDocument();
    }
  });
});
