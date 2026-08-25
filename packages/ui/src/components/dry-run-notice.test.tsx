import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { dryRun } from '@am/domain';
import { createUser, installDomPolyfills } from '../test/dom';
import { DryRunNotice, isDryRunResult } from './dry-run-notice';

beforeAll(() => {
  installDomPolyfills();
});

const RESULT = dryRun('META', 'campaigns.create', {
  name: 'A&M – Handwerk Q3',
  status: 'PAUSED',
  daily_budget: 5000,
});

describe('DryRunNotice', () => {
  it('states unmistakably that nothing was executed', () => {
    render(<DryRunNotice result={RESULT} />);

    expect(screen.getByText('Dry-Run – nicht ausgeführt')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Externe Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED=false).',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Es wurde nichts an META gesendet/)).toBeInTheDocument();
  });

  it('names the provider and the operation', () => {
    render(<DryRunNotice result={RESULT} />);

    expect(screen.getByText('META')).toBeInTheDocument();
    expect(screen.getByText('campaigns.create')).toBeInTheDocument();
  });

  it('reveals the payload behind a keyboard-operable disclosure', async () => {
    const user = createUser();
    render(<DryRunNotice result={RESULT} />);

    const toggle = screen.getByRole('button', {
      name: 'Nutzlast anzeigen (würde gesendet werden)',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);

    expect(screen.getByRole('button', { name: 'Nutzlast ausblenden' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText(/A&M – Handwerk Q3/)).toBeInTheDocument();
  });
});

describe('isDryRunResult', () => {
  it('recognises a dry run envelope and rejects anything else', () => {
    expect(isDryRunResult(RESULT)).toBe(true);
    expect(isDryRunResult({ ok: true })).toBe(false);
    expect(isDryRunResult(null)).toBe(false);
  });
});
