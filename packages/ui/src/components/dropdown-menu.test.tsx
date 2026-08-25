import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createUser, installDomPolyfills } from '../test/dom';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';

beforeAll(() => {
  installDomPolyfills();
});

function Menu({ onPause = () => {} }: { onPause?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">Aktionen</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Kampagne</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onPause}>Pausieren</DropdownMenuItem>
        <DropdownMenuItem>Budget anpassen</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="destructive">Archivieren</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe('DropdownMenu keyboard navigation', () => {
  it('opens from the keyboard and focuses the first item', async () => {
    const user = createUser();
    render(<Menu />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Aktionen' })).toHaveFocus();

    await user.keyboard('{Enter}');

    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Pausieren' })).toHaveFocus();
    });
  });

  it('moves the focus with the arrow keys and activates with Enter', async () => {
    const user = createUser();
    const onPause = vi.fn();
    render(<Menu onPause={onPause} />);

    await user.tab();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('menu');

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Pausieren' })).toHaveFocus();
    });

    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Budget anpassen' })).toHaveFocus();
    });

    await user.keyboard('{ArrowUp}');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Pausieren' })).toHaveFocus();
    });

    await user.keyboard('{Enter}');
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and returns the focus to the trigger', async () => {
    const user = createUser();
    render(<Menu />);

    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Aktionen' })).toHaveFocus();
  });
});
