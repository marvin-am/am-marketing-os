import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createUser, installDomPolyfills } from '../test/dom';
import { Button } from './button';
import { EmptyState, ErrorState, LoadingState } from './states';

beforeAll(() => {
  installDomPolyfills();
});

describe('ErrorState', () => {
  it('renders a German message and a retry button', async () => {
    const user = createUser();
    const onRetry = vi.fn();

    render(<ErrorState onRetry={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Die Daten konnten nicht geladen werden.',
    );

    const retry = screen.getByRole('button', { name: 'Erneut versuchen' });
    await user.click(retry);

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the technical detail without leaking it into the headline', () => {
    render(<ErrorState detail="META_SYNC_FAILED · corr-9f21" onRetry={() => {}} />);

    expect(screen.getByText('META_SYNC_FAILED · corr-9f21')).toBeInTheDocument();
  });

  it('blocks a second submit while a retry is in flight', () => {
    render(<ErrorState onRetry={() => {}} retrying />);

    expect(screen.getByRole('button', { name: /Erneut versuchen/ })).toBeDisabled();
  });
});

describe('EmptyState', () => {
  it('always says what to do next', () => {
    render(
      <EmptyState
        title="Noch keine Kampagnen"
        description="Legen Sie eine Kampagne an, um Angles und Creatives zu erzeugen."
        action={<Button>Kampagne anlegen</Button>}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Noch keine Kampagnen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kampagne anlegen' })).toBeInTheDocument();
  });
});

describe('LoadingState', () => {
  it('announces itself instead of rendering a silent blank area', () => {
    render(<LoadingState />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Daten werden geladen …');
  });
});
