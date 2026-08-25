import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { actionOk } from '@/lib/action-result';
import { FIXTURE_CAMPAIGN_IDS, getCampaignPort } from '@/server/campaign-fixtures';
import { BudgetPanel } from './budget-panel';
import { budgetRefusalDe } from './gates';

async function header() {
  const view = await getCampaignPort().getHeader(FIXTURE_CAMPAIGN_IDS.live, false);
  if (!view) throw new Error('Fixture campaign missing');
  return view;
}

/**
 * Acceptance criterion 24: a change beyond the role's authority is refused with
 * the approving role named — it is never quietly reduced to what the role may
 * do.
 */
describe('budgetRefusalDe', () => {
  it('permits an increase inside the role limit', () => {
    expect(budgetRefusalDe(['MARKETING_LEAD'], 10_000, 12_000)).toBeNull();
  });

  it('refuses an increase beyond the role limit and names the approving role', () => {
    const refusal = budgetRefusalDe(['MARKETING_LEAD'], 10_000, 18_000);
    expect(refusal).toMatch(/wird nicht gekürzt, sondern abgelehnt/);
    expect(refusal).toMatch(/Executive/);
  });

  it('never permits a decrease to be treated as a scale', () => {
    expect(budgetRefusalDe(['MARKETING_LEAD'], 10_000, 8_000)).toBeNull();
  });

  it('refuses a zero or negative budget', () => {
    expect(budgetRefusalDe(['ADMIN'], 10_000, 0)).toMatch(/größer als 0,00 €/);
  });
});

describe('BudgetPanel', () => {
  it('shows the refusal before anything is submitted and blocks the button', async () => {
    const user = userEvent.setup();
    const view = await header();
    const change = vi.fn(async () => actionOk(view));

    render(
      <BudgetPanel
        campaignId={view.id}
        currentMinor={view.budget.amountMinor}
        currency={view.budget.currency}
        roles={['MARKETING_LEAD']}
        canChange
        change={change}
      />,
    );

    const amount = screen.getByLabelText(/Neues Tagesbudget/);
    const beyondLeadLimit = Math.round(view.budget.amountMinor * 1.5);
    await user.clear(amount);
    await user.type(amount, (beyondLeadLimit / 100).toFixed(2));
    await user.type(screen.getByLabelText(/Begründung/), 'Skalierung nach reifer Kohorte.');

    expect(document.querySelector('[data-budget-refusal]')).toHaveTextContent(
      /muss durch die Rolle „Executive" freigegeben werden/,
    );
    expect(screen.getByRole('button', { name: 'Budget ändern' })).toBeDisabled();
    expect(change).not.toHaveBeenCalled();
  });

  it('confirms an in-limit change through the dialog before sending it', async () => {
    const user = userEvent.setup();
    const view = await header();
    const change = vi.fn(async () => actionOk(view));
    const next = Math.round(view.budget.amountMinor * 1.1);

    render(
      <BudgetPanel
        campaignId={view.id}
        currentMinor={view.budget.amountMinor}
        currency={view.budget.currency}
        roles={['MARKETING_LEAD']}
        canChange
        change={change}
      />,
    );

    const amount = screen.getByLabelText(/Neues Tagesbudget/);
    await user.clear(amount);
    await user.type(amount, (next / 100).toFixed(2));
    await user.type(screen.getByLabelText(/Begründung/), 'Skalierung nach reifer Kohorte.');

    expect(document.querySelector('[data-budget-refusal]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Budget ändern' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Tagesbudget ändern');
    expect(change).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Änderung speichern' }));
    expect(change).toHaveBeenCalledWith({
      campaignId: view.id,
      newDailyBudgetMinor: next,
      reasonDe: 'Skalierung nach reifer Kohorte.',
    });
  });

  it('explains rather than showing a dead control when the role may not change budgets', async () => {
    const view = await header();
    render(
      <BudgetPanel
        campaignId={view.id}
        currentMinor={view.budget.amountMinor}
        currency={view.budget.currency}
        roles={['MARKETING_OPERATOR']}
        canChange={false}
        change={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Budget ändern' })).not.toBeInTheDocument();
    expect(screen.getByText(/Ihre Rolle darf das Budget nicht ändern/)).toBeInTheDocument();
  });
});
