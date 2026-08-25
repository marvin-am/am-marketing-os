import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, installDomPolyfills } from '../test/dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

beforeAll(() => {
  installDomPolyfills();
});

function CampaignTabs() {
  return (
    <Tabs defaultValue="strategie">
      <TabsList aria-label="Kampagnenbereiche">
        <TabsTrigger value="strategie">Strategie</TabsTrigger>
        <TabsTrigger value="creatives">Creatives</TabsTrigger>
        <TabsTrigger value="messung">Messung</TabsTrigger>
      </TabsList>
      <TabsContent value="strategie">Angle und Offer</TabsContent>
      <TabsContent value="creatives">Creative-Varianten</TabsContent>
      <TabsContent value="messung">Kennzahlen</TabsContent>
    </Tabs>
  );
}

describe('Tabs keyboard navigation', () => {
  it('exposes a labelled tab list with one selected tab', () => {
    render(<CampaignTabs />);

    expect(screen.getByRole('tablist', { name: 'Kampagnenbereiche' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Strategie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Angle und Offer');
  });

  it('moves between tabs with the arrow keys and wraps around', async () => {
    const user = createUser();
    render(<CampaignTabs />);

    await user.tab();
    expect(screen.getByRole('tab', { name: 'Strategie' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Creatives' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Creative-Varianten');

    await user.keyboard('{ArrowLeft}');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Strategie' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    await user.keyboard('{ArrowLeft}');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Messung' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  });

  it('jumps to the first and last tab with Home and End', async () => {
    const user = createUser();
    render(<CampaignTabs />);

    await user.tab();
    await user.keyboard('{End}');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Messung' })).toHaveFocus();
    });

    await user.keyboard('{Home}');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Strategie' })).toHaveFocus();
    });
  });

  it('keeps the tab list a single tab stop', async () => {
    const user = createUser();
    render(<CampaignTabs />);

    await user.tab();
    expect(screen.getByRole('tab', { name: 'Strategie' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('tab', { name: 'Strategie' })).not.toHaveFocus();
  });
});
