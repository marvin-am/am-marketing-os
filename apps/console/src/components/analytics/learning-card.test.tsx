import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIDENCE_LABELS_DE, type LearningCard } from '@am/domain';
import { CONFIDENCE_EXPLANATIONS_DE } from '@am/ui';
import { createAnalyticsFixturePort } from '@/server/analytics-fixtures';
import { LearningCardView } from './learning-card';
import { LearningsBrowser } from './learnings-browser';

const NOW = '2026-08-25T09:00:00.000Z';
const port = createAnalyticsFixturePort({ now: NOW });

let cards: LearningCard[];

beforeAll(async () => {
  cards = await port.listLearningCards();
});

function cardWith(confidence: LearningCard['confidence']): LearningCard {
  const found = cards.find((card) => card.confidence === confidence);
  if (!found) throw new Error(`Keine Learning-Karte mit Belegstärke ${confidence}`);
  return found;
}

describe('LearningCardView', () => {
  it('renders the computed confidence label together with what it means', () => {
    const card = cardWith('FACT');
    const { container } = render(<LearningCardView card={card} />);

    expect(container.querySelector('[data-confidence="FACT"]')).not.toBeNull();
    expect(screen.getAllByText(CONFIDENCE_LABELS_DE.FACT).length).toBeGreaterThan(0);
    expect(screen.getAllByText(CONFIDENCE_EXPLANATIONS_DE.FACT).length).toBeGreaterThan(0);
  });

  it('marks a hypothesis as something to test rather than to report', () => {
    const card = cardWith('HYPOTHESIS');
    const { container } = render(<LearningCardView card={card} />);

    expect(container.querySelector('[data-confidence="HYPOTHESIS"]')).not.toBeNull();
    expect(screen.getAllByText(CONFIDENCE_EXPLANATIONS_DE.HYPOTHESIS).length).toBeGreaterThan(0);
    expect(container.textContent).toContain('Sie ist zu testen, nicht zu berichten.');
  });

  it('shows what was tested, angle, offer, funnel type, period, spend and next test', () => {
    const card = cardWith('FACT');
    render(<LearningCardView card={card} />);

    expect(screen.getByText('Was getestet wurde')).toBeInTheDocument();
    expect(screen.getByText(card.whatWasTestedDe)).toBeInTheDocument();
    expect(screen.getByText('Angle')).toBeInTheDocument();
    expect(screen.getByText('Offer')).toBeInTheDocument();
    expect(screen.getByText('Funnel-Typ')).toBeInTheDocument();
    expect(screen.getByText('Zeitraum')).toBeInTheDocument();
    expect(screen.getByText('Spend')).toBeInTheDocument();
    expect(screen.getByText('Mögliche Erklärung')).toBeInTheDocument();
    expect(screen.getByText('Vorgeschlagener nächster Test')).toBeInTheDocument();
  });

  it('renders every outcome fact with its numerator and denominator', () => {
    const card = cardWith('FACT');
    const { container } = render(<LearningCardView card={card} />);

    for (const fact of card.outcomeFacts) {
      if (fact.numerator === null || fact.denominator === null) continue;
      const expected = `${fact.numerator.toLocaleString('de-DE')} / ${fact.denominator.toLocaleString('de-DE')}`;
      expect(container.textContent).toContain(expected);
    }
  });

  it('shows data maturity and attribution coverage beside the confidence label', () => {
    const card = cardWith('INDICATION');
    const { container } = render(<LearningCardView card={card} />);

    expect(container.querySelector('[data-maturity]')).not.toBeNull();
    expect(container.querySelector('[data-coverage]')).not.toBeNull();
  });
});

describe('LearningsBrowser', () => {
  it('filters by confidence and reports how many cards remain', async () => {
    const user = userEvent.setup();
    render(<LearningsBrowser cards={cards} />);

    const expectedFacts = cards.filter((card) => card.confidence === 'FACT').length;
    await user.click(screen.getByRole('combobox', { name: 'Belegstärke' }));
    await user.click(screen.getByRole('option', { name: CONFIDENCE_LABELS_DE.FACT }));

    expect(
      screen.getByRole('status').textContent?.replace(/\s+/g, ' '),
    ).toContain(`${expectedFacts} von ${cards.length} Learnings`);
  });

  it('searches across title, outcome and explanation', async () => {
    const user = userEvent.setup();
    render(<LearningsBrowser cards={cards} />);

    await user.type(screen.getByLabelText('Suche'), 'Formularschritte');
    const status = screen.getByRole('status').textContent?.replace(/\s+/g, ' ') ?? '';
    expect(status).toMatch(/^[1-9]\d* von \d+ Learnings$/);
    expect(status).not.toContain(`${cards.length} von ${cards.length}`);
  });

  it('offers a way back when a filter matches nothing', async () => {
    const user = userEvent.setup();
    render(<LearningsBrowser cards={cards} />);

    await user.type(screen.getByLabelText('Suche'), 'zzz-existiert-nicht');
    expect(screen.getByText('Keine Learnings für diese Filter')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Filter zurücksetzen' })[0]);
    expect(screen.queryByText('Keine Learnings für diese Filter')).toBeNull();
  });
});
