import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type ComponentProps } from 'react';
import { createUser, installDomPolyfills } from '../test/dom';
import { ConfirmDialog } from './confirm-dialog';

beforeAll(() => {
  installDomPolyfills();
});

function renderDialog(overrides: Partial<ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Kampagne live schalten"
      preview={<p>Meta-Kampagne 123 wird von PAUSED auf ACTIVE gesetzt.</p>}
      confirmPhrase="LIVE"
      confirmLabel="Live schalten"
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe('ConfirmDialog', () => {
  it('shows the preview of exactly what will happen', () => {
    renderDialog();

    expect(screen.getByRole('alertdialog', { name: 'Kampagne live schalten' })).toBeInTheDocument();
    expect(
      screen.getByText('Meta-Kampagne 123 wird von PAUSED auf ACTIVE gesetzt.'),
    ).toBeInTheDocument();
  });

  it('does not fire the action before the phrase is typed', async () => {
    const user = createUser();
    const { onConfirm } = renderDialog();

    const confirm = screen.getByRole('button', { name: 'Live schalten' });
    expect(confirm).toBeDisabled();

    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox'), 'live');
    expect(screen.getByRole('button', { name: 'Live schalten' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Live schalten' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('fires the action once the exact phrase has been confirmed', async () => {
    const user = createUser();
    const { onConfirm } = renderDialog();

    await user.type(screen.getByRole('textbox'), 'LIVE');
    const confirm = screen.getByRole('button', { name: 'Live schalten' });
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancelling closes the dialog without running the action', async () => {
    const user = createUser();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('also requires the acknowledgement when one is configured', async () => {
    const user = createUser();
    const { onConfirm } = renderDialog({
      confirmPhrase: undefined,
      acknowledgement: 'Ich habe die Vorschau geprüft.',
    });

    const confirm = screen.getByRole('button', { name: 'Live schalten' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Ich habe die Vorschau geprüft.' }));
    await user.click(screen.getByRole('button', { name: 'Live schalten' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
