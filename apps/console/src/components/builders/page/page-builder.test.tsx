import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HYBRID_FUNNEL_SPEC, LANDING_PAGE_SPEC, PAGE_BLOCK_LABELS_DE } from '@am/funnel-schema';
import { actionOk } from '@/lib/action-result';
import type { PageBuilderCommands, PageDocumentSpec } from '../port';
import { PageBuilder } from './page-builder';

/**
 * The page builder's contract: blocks can be added, reordered without a mouse,
 * duplicated and deleted; the preview follows every edit; and a page that would
 * ship without an imprint cannot be saved.
 */

function setupUser() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

function makeCommands(): PageBuilderCommands {
  return {
    save: vi.fn(async () => actionOk({ versionId: 'entwurf', version: 2 })),
    publish: vi.fn(async () => actionOk({ versionId: 'entwurf' })),
    duplicate: vi.fn(async () => actionOk({ versionId: 'kopie', version: 3 })),
    restore: vi.fn(async () => actionOk({ versionId: 'zurueck', version: 4 })),
  };
}

function renderBuilder(
  spec: PageDocumentSpec = LANDING_PAGE_SPEC,
  overrides: Partial<React.ComponentProps<typeof PageBuilder>> = {},
) {
  const commands = overrides.commands ?? makeCommands();
  render(
    <PageBuilder
      initialSpec={spec}
      version={2}
      published={false}
      versions={[]}
      availableForms={[
        {
          formId: HYBRID_FUNNEL_SPEC.form.formId,
          formVersionId: HYBRID_FUNNEL_SPEC.form.formVersionId,
          labelDe: 'Potenzialanalyse — veröffentlicht v1',
        },
      ]}
      commands={commands}
      onOpenVersion={vi.fn()}
      {...overrides}
    />,
  );
  return { commands };
}

const nav = () => screen.getByRole('navigation', { name: 'Struktur der Seite' });
const editor = () => screen.getByRole('region', { name: 'Bearbeiten' });
const preview = () => screen.getByRole('region', { name: 'Vorschau' });
const summary = () => screen.getByTestId('issue-summary');

describe('PageBuilder — Blöcke', () => {
  it('fügt einen Block hinzu, zeigt ihn in der Vorschau und bleibt gültig', async () => {
    const user = setupUser();
    renderBuilder();

    expect(summary()).toHaveTextContent('Keine offenen Hinweise');

    await user.selectOptions(within(nav()).getByLabelText('Blocktyp'), 'BOOKING_CTA');
    await user.click(within(nav()).getByRole('button', { name: 'Block' }));

    expect(
      within(nav()).getByRole('button', { name: /Terminbuchung$/ }),
    ).toBeInTheDocument();
    expect(within(preview()).getByText('Termin vereinbaren')).toBeInTheDocument();
    expect(summary()).toHaveTextContent('Keine offenen Hinweise');
  });

  it('sortiert Blöcke allein mit der Tastatur um', async () => {
    const user = setupUser();
    renderBuilder();

    const second = LANDING_PAGE_SPEC.blocks[1]!;
    const moveUp = within(nav()).getByRole('button', {
      name: `Block ${PAGE_BLOCK_LABELS_DE[second.type]} nach oben verschieben`,
    });

    moveUp.focus();
    await user.keyboard('{Enter}');

    expect(within(nav()).getByTestId(`orderable-item-${second.blockId}`)).toHaveAttribute(
      'data-position',
      '1',
    );
  });

  it('dupliziert einen Block mit eigener Kennung', async () => {
    const user = setupUser();
    renderBuilder();

    const hero = LANDING_PAGE_SPEC.blocks[0]!;
    await user.click(
      within(nav()).getByRole('button', {
        name: `Block „${PAGE_BLOCK_LABELS_DE[hero.type]}“ duplizieren`,
      }),
    );

    expect(
      within(nav()).getByTestId(`orderable-item-${hero.blockId}_kopie`),
    ).toBeInTheDocument();
  });

  it('sperrt das Speichern, wenn die Rechtsblöcke fehlen', async () => {
    const user = setupUser();
    renderBuilder();

    const legal = LANDING_PAGE_SPEC.blocks.find((block) => block.type === 'FOOTER_LEGAL')!;
    await user.click(
      within(nav()).getByRole('button', {
        name: `Block „${PAGE_BLOCK_LABELS_DE.FOOTER_LEGAL}“ löschen`,
      }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(legal.blockId);
    await user.click(within(dialog).getByRole('button', { name: 'Block löschen' }));

    expect(summary()).toHaveTextContent('Impressum und Datenschutzerklärung');
    expect(screen.getByRole('button', { name: 'Entwurf speichern' })).toBeDisabled();
  });

  it('bearbeitet die typisierten Felder eines Blocks', async () => {
    const user = setupUser();
    renderBuilder();

    const headline = within(editor()).getAllByLabelText('Überschrift')[0]!;
    await user.clear(headline);
    await user.type(headline, 'Neue Hero-Überschrift');

    expect(within(preview()).getByText('Neue Hero-Überschrift')).toBeInTheDocument();
  });
});

describe('PageBuilder — hybride Strecke', () => {
  it('zeigt die Formularreferenz und das eingebettete Formular in der Vorschau', async () => {
    const user = setupUser();
    renderBuilder(HYBRID_FUNNEL_SPEC);

    expect(within(preview()).getByTestId('embedded-form-slot')).toBeInTheDocument();

    await user.click(within(nav()).getByRole('button', { name: 'Seiteneinstellungen' }));
    const formRef = within(editor()).getByText('Eingebundenes Formular');
    expect(formRef).toBeInTheDocument();
    expect(within(editor()).getByLabelText('Darstellung')).toHaveValue('MODAL');
  });

  it('öffnet eine veröffentlichte Seite schreibgeschützt', () => {
    renderBuilder(LANDING_PAGE_SPEC, { published: true });

    expect(screen.getByText('Veröffentlichte Version — schreibgeschützt')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Entwurf speichern' })).not.toBeInTheDocument();
    expect(within(nav()).getByRole('button', { name: 'Block' })).toBeDisabled();
  });
});
