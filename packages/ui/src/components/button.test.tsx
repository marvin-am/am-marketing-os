import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createUser, installDomPolyfills } from '../test/dom';
import { Button } from './button';

beforeAll(() => {
  installDomPolyfills();
});

describe('Button', () => {
  it('renders a real button with an explicit type', () => {
    render(<Button>Speichern</Button>);

    const button = screen.getByRole('button', { name: 'Speichern' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toBeEnabled();
  });

  it('announces the loading state and blocks a second submit', async () => {
    const user = createUser();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Speichern
      </Button>,
    );

    const button = screen.getByRole('button', { name: /Speichern/ });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    expect(screen.getByText('Wird ausgeführt …')).toBeInTheDocument();

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  describe('asChild', () => {
    // Regression: Slot renders exactly one element, so a spinner rendered as a
    // sibling of `children` used to blow up with `React.Children.only`.
    it('renders the child element without throwing', () => {
      expect(() =>
        render(
          <Button asChild>
            <a href="/heute">Zur Übersicht</a>
          </Button>,
        ),
      ).not.toThrow();

      const link = screen.getByRole('link', { name: 'Zur Übersicht' });
      expect(link).toHaveAttribute('href', '/heute');
      // No nested button, and no `type` leaking onto the anchor.
      expect(screen.queryByRole('button')).toBeNull();
      expect(link).not.toHaveAttribute('type');
    });

    it('still renders the spinner while loading', () => {
      expect(() =>
        render(
          <Button asChild loading>
            <a href="/heute">Zur Übersicht</a>
          </Button>,
        ),
      ).not.toThrow();

      const link = screen.getByRole('link', { name: /Zur Übersicht/ });
      expect(link).toHaveAttribute('aria-busy', 'true');
      expect(link).toHaveAttribute('data-loading');
      expect(screen.getByText('Wird ausgeführt …')).toBeInTheDocument();
      expect(link.querySelector('svg')).not.toBeNull();
      expect(link).toHaveTextContent('Zur Übersicht');
    });

    it('merges the button classes onto the child', () => {
      render(
        <Button asChild variant="secondary">
          <a href="/heute">Zur Übersicht</a>
        </Button>,
      );

      expect(screen.getByRole('link', { name: 'Zur Übersicht' }).className).toContain(
        'inline-flex',
      );
    });
  });
});
