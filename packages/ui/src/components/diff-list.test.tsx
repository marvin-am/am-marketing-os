import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildDiffEntries, DiffList, formatDiffValue } from './diff-list';

describe('buildDiffEntries', () => {
  it('classifies added, removed, changed and unchanged fields by dot path', () => {
    const entries = buildDiffEntries(
      { offer: { priceMinor: 990_00, name: 'Basis' }, active: true },
      { offer: { priceMinor: 1_490_00, name: 'Basis', bonus: 'Audit' }, active: true },
    );

    const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry]));

    expect(byPath['offer.priceMinor']?.change).toBe('changed');
    expect(byPath['offer.name']?.change).toBe('unchanged');
    expect(byPath['offer.bonus']?.change).toBe('added');
    expect(byPath['active']?.change).toBe('unchanged');
  });

  it('marks a field that disappeared as removed', () => {
    const entries = buildDiffEntries({ note: 'alt' }, {});
    expect(entries[0]?.change).toBe('removed');
  });
});

describe('formatDiffValue', () => {
  it('renders German values and never invents one', () => {
    expect(formatDiffValue(true)).toBe('Ja');
    expect(formatDiffValue(false)).toBe('Nein');
    expect(formatDiffValue(1234.5)).toBe('1.234,5');
    expect(formatDiffValue(null)).toBe('–');
    expect(formatDiffValue(undefined)).toBe('nicht gesetzt');
    expect(formatDiffValue('')).toBe('(leer)');
  });
});

describe('DiffList', () => {
  it('labels both sides in German and names the change kind in words', () => {
    render(
      <DiffList
        entries={buildDiffEntries({ budgetMinor: 5000 }, { budgetMinor: 8000 })}
      />,
    );

    expect(screen.getByText('Vorher')).toBeInTheDocument();
    expect(screen.getByText('Nachher')).toBeInTheDocument();
    expect(screen.getByText('Geändert')).toBeInTheDocument();
    expect(screen.getByText('5.000')).toBeInTheDocument();
    expect(screen.getByText('8.000')).toBeInTheDocument();
  });

  it('hides unchanged rows unless asked for them', () => {
    const entries = buildDiffEntries({ a: 1, b: 2 }, { a: 1, b: 3 });

    const { rerender } = render(<DiffList entries={entries} />);
    expect(screen.queryByText('Unverändert')).toBeNull();

    rerender(<DiffList entries={entries} includeUnchanged />);
    expect(screen.getByText('Unverändert')).toBeInTheDocument();
  });

  it('says so in German when nothing changed', () => {
    render(<DiffList entries={buildDiffEntries({ a: 1 }, { a: 1 })} />);
    expect(screen.getByText('Keine Änderungen.')).toBeInTheDocument();
  });
});
