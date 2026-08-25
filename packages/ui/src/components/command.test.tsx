import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createUser, installDomPolyfills } from '../test/dom';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';

beforeAll(() => {
  installDomPolyfills();
});

function Palette({ onSelect = () => {} }: { onSelect?: (value: string) => void }) {
  return (
    <Command label="Kampagne suchen" onSelect={onSelect}>
      <CommandInput placeholder="Kampagne suchen …" />
      <CommandList>
        <CommandEmpty>Keine Kampagne gefunden.</CommandEmpty>
        <CommandGroup heading="Kampagnen">
          <CommandItem value="Handwerk Q3">Handwerk Q3</CommandItem>
          <CommandItem value="Lösungsvertrieb">Lösungsvertrieb</CommandItem>
          <CommandItem value="Straßenbau">Straßenbau</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

describe('Command', () => {
  it('wires the combobox to its listbox and highlights the first option', async () => {
    render(<Palette />);

    const input = screen.getByRole('combobox');
    const list = screen.getByRole('listbox');

    expect(input).toHaveAttribute('aria-controls', list.id);
    await waitFor(() => {
      expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
    });
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('moves the active option with the arrow keys and selects with Enter', async () => {
    const user = createUser();
    const onSelect = vi.fn();
    render(<Palette onSelect={onSelect} />);

    const input = screen.getByRole('combobox');
    await user.click(input);

    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Lösungsvertrieb' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    await user.keyboard('{End}');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Straßenbau' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('Straßenbau');
  });

  it('filters case-, accent- and ß-insensitively', async () => {
    const user = createUser();
    render(<Palette />);

    await user.type(screen.getByRole('combobox'), 'strassen');

    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(1);
    });
    expect(screen.getByRole('option', { name: 'Straßenbau' })).toBeInTheDocument();
  });

  it('shows a German empty state instead of a blank list', async () => {
    const user = createUser();
    render(<Palette />);

    await user.type(screen.getByRole('combobox'), 'zzz');

    await waitFor(() => {
      expect(screen.getByText('Keine Kampagne gefunden.')).toBeInTheDocument();
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});
