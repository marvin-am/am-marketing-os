import { render, screen } from '@testing-library/react';
import { dryRun } from '@am/domain';
import { describe, expect, it } from 'vitest';
import { actionDryRun, actionError, actionOk } from '@/lib/action-result';
import { ActionFeedback } from './action-feedback';

describe('ActionFeedback', () => {
  it('renders a dry run as a dry-run notice and never as success', () => {
    const result = actionDryRun<unknown>(
      dryRun('META', 'campaign.create_draft', { name: 'Q3 Neukunden', status: 'PAUSED' }),
    );

    const { container } = render(
      <ActionFeedback result={result} successTitleDe="Entwurf angelegt." />,
    );

    // The dry-run banner is present …
    expect(container.querySelector('[data-dry-run="true"]')).not.toBeNull();
    expect(screen.getByText('Dry-Run – nicht ausgeführt')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Externe Schreibzugriffe sind deaktiviert (EXTERNAL_WRITES_ENABLED=false).',
      ),
    ).toBeInTheDocument();

    // … and nothing claims the action succeeded.
    expect(container.querySelector('[data-action-ok="true"]')).toBeNull();
    expect(screen.queryByText('Entwurf angelegt.')).not.toBeInTheDocument();
  });

  it('renders an error with its German message and field errors', () => {
    render(
      <ActionFeedback
        result={actionError<unknown>('MAPPING_INCOMPLETE', 'Es fehlen Pflichtangaben.', {
          fieldErrors: { 'pipeline.pipelineId': 'Es ist keine Deal-Pipeline ausgewählt.' },
        })}
        successTitleDe="Gespeichert."
      />,
    );

    expect(screen.getByText('Die Aktion wurde nicht ausgeführt.')).toBeInTheDocument();
    expect(screen.getByText(/Es fehlen Pflichtangaben\./)).toBeInTheDocument();
    expect(screen.getByText('pipeline.pipelineId')).toBeInTheDocument();
    expect(screen.queryByText('Gespeichert.')).not.toBeInTheDocument();
  });

  it('renders success only for an ok result', () => {
    const { container } = render(
      <ActionFeedback result={actionOk({ ok: true })} successTitleDe="Gespeichert." />,
    );

    expect(container.querySelector('[data-action-ok="true"]')).not.toBeNull();
    expect(screen.getByText('Gespeichert.')).toBeInTheDocument();
  });

  it('renders nothing before an action has run', () => {
    const { container } = render(<ActionFeedback result={null} successTitleDe="Gespeichert." />);
    expect(container).toBeEmptyDOMElement();
  });
});
