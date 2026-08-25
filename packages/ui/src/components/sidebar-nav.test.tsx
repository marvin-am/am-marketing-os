import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SidebarNav, SidebarNavGroup, SidebarNavItem } from './sidebar-nav';

function Nav({ asChild = false }: { asChild?: boolean }) {
  const label = 'Kampagnen';
  return (
    <SidebarNav label="Hauptnavigation">
      <SidebarNavGroup label="Steuerung">
        <SidebarNavItem
          asChild={asChild}
          active
          icon={<svg data-testid="nav-icon" />}
          badge={3}
          {...(asChild ? {} : { href: '/kampagnen' })}
        >
          {asChild ? <a href="/kampagnen">{label}</a> : label}
        </SidebarNavItem>
        <SidebarNavItem href="/heute">Heute</SidebarNavItem>
      </SidebarNavGroup>
    </SidebarNav>
  );
}

describe('SidebarNav', () => {
  it('exposes a labelled navigation landmark and a labelled group', () => {
    render(<Nav />);

    expect(screen.getByRole('navigation', { name: 'Hauptnavigation' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Steuerung' })).toBeInTheDocument();
  });

  it('marks the current page with aria-current, not only with colour', () => {
    render(<Nav />);

    const current = screen.getByRole('link', { name: /Kampagnen/ });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current).toHaveAttribute('data-active');
  });

  // Regression: icon + label + badge are siblings under Slot, which used to
  // trip `React.Children.only` the moment `asChild` was set.
  it('renders with asChild, an icon and a badge without throwing', () => {
    expect(() => render(<Nav asChild />)).not.toThrow();

    const link = screen.getByRole('link', { name: /Kampagnen/ });
    expect(link).toHaveAttribute('href', '/kampagnen');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveTextContent('Kampagnen');
    expect(link).toHaveTextContent('3');
    expect(screen.getByTestId('nav-icon')).toBeInTheDocument();
  });
});
