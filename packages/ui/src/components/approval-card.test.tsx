import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type Approval } from '@am/domain';
import { ApprovalCard } from './approval-card';

const BASE: Approval = {
  id: '11111111-1111-4111-8111-111111111111',
  campaign_id: '22222222-2222-4222-8222-222222222222',
  kind: 'STRATEGY',
  state: 'APPROVED',
  approved_content_hash: 'a'.repeat(64),
  approved_by: '33333333-3333-4333-8333-333333333333',
  approved_at: '2026-08-20T09:30:00.000Z',
  rejected_reason_de: null,
  invalidated_at: null,
  invalidated_reason_de: null,
  created_at: '2026-08-19T08:00:00.000Z',
};

describe('ApprovalCard', () => {
  it('names the approval kind, the state and who approved it', () => {
    render(<ApprovalCard approval={BASE} approverName="M. Flenche" />);

    expect(screen.getByText('Strategie (Angle, Offer, Claims)')).toBeInTheDocument();
    expect(screen.getByText('Freigegeben')).toBeInTheDocument();
    expect(screen.getByText(/M\. Flenche/)).toBeInTheDocument();
  });

  it('warns when the content changed after the approval', () => {
    render(
      <ApprovalCard approval={BASE} approverName="M. Flenche" currentContentHash={'b'.repeat(64)} />,
    );

    expect(screen.getByText('Durch Änderung ungültig')).toBeInTheDocument();
    expect(screen.getByText(/deckt den aktuellen Stand nicht mehr ab/)).toBeInTheDocument();
  });

  it('stays quiet while the approved hash still matches', () => {
    render(
      <ApprovalCard approval={BASE} approverName="M. Flenche" currentContentHash={'a'.repeat(64)} />,
    );

    expect(screen.queryByText('Durch Änderung ungültig')).toBeNull();
  });

  it('shows the German rejection reason', () => {
    render(
      <ApprovalCard
        approval={{
          ...BASE,
          state: 'REJECTED',
          approved_at: null,
          approved_by: null,
          rejected_reason_de: 'Claim ohne belegte Quelle.',
        }}
      />,
    );

    expect(screen.getByText('Ablehnungsgrund')).toBeInTheDocument();
    expect(screen.getByText('Claim ohne belegte Quelle.')).toBeInTheDocument();
  });
});
