import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type StatusSelector } from '../lib/status';
import { StatusBadge } from './status-badge';

const CASES: ReadonlyArray<readonly [StatusSelector, string]> = [
  [{ kind: 'campaign', state: 'LIVE' }, 'Live'],
  [{ kind: 'campaign', state: 'META_DRAFT_CREATED' }, 'Meta-Entwurf erstellt (pausiert)'],
  [{ kind: 'campaign', state: 'STRATEGY_APPROVED' }, 'Strategie freigegeben'],
  [{ kind: 'campaignError', state: 'META_SYNC_FAILED' }, 'Meta-Synchronisation fehlgeschlagen'],
  [{ kind: 'approval', state: 'PENDING' }, 'Freigabe ausstehend'],
  [{ kind: 'approval', state: 'INVALIDATED' }, 'Durch Änderung ungültig'],
  [{ kind: 'sync', state: 'FAILED_RETRYING' }, 'Sync fehlgeschlagen – Wiederholung'],
  [{ kind: 'command', state: 'PROVIDER_CONFIRMED' }, 'Vom Provider bestätigt'],
  [{ kind: 'command', state: 'BLOCKED_BY_FLAG' }, 'Durch Sicherheits-Flag blockiert'],
  [{ kind: 'health', state: 'AWAITING_EXTERNAL_INPUT' }, 'Wartet auf externen Input'],
  [{ kind: 'connection', state: 'FIXTURE' }, 'Fixture-Modus'],
  [{ kind: 'experiment', state: 'RUNNING' }, 'Läuft'],
  [{ kind: 'verdict', state: 'INSUFFICIENT_DATA' }, 'Datenbasis zu klein'],
];

describe('StatusBadge', () => {
  for (const [selector, label] of CASES) {
    it(`renders ${selector.kind}/${String(selector.state)} as "${label}"`, () => {
      render(<StatusBadge {...selector} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  }

  it('never signals state by colour alone: an icon accompanies every label', () => {
    const { container } = render(<StatusBadge kind="campaign" state="PAUSED" />);

    expect(screen.getByText('Pausiert')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('exposes the raw state for styling and end-to-end selectors', () => {
    const { container } = render(<StatusBadge kind="command" state="FAILED" />);
    const badge = container.querySelector('[data-status-kind="command"]');

    expect(badge).toHaveAttribute('data-status-state', 'FAILED');
  });

  it('appends a suffix without replacing the label', () => {
    render(<StatusBadge kind="sync" state="FAILED_RETRYING" suffix="3/5" />);

    expect(screen.getByText('Sync fehlgeschlagen – Wiederholung')).toBeInTheDocument();
    expect(screen.getByText('3/5')).toBeInTheDocument();
  });
});
