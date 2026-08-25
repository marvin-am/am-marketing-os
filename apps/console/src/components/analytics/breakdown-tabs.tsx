'use client';

import * as React from 'react';
import Link from 'next/link';
import { ROLLUP_DIMENSION_LABELS_DE, type RollupDimension } from '@am/experiments';
import { Section, Tabs, TabsContent, TabsList, TabsTrigger } from '@am/ui';
import type { Breakdown, BreakdownRow } from '@/server/analytics-port';
import { BreakdownBarChart } from './breakdown-bar-chart';
import { BreakdownTable } from './breakdown-table';

const ENTITY_LABELS_DE: Readonly<Record<RollupDimension, string>> = {
  CAMPAIGN: 'Kampagne',
  CREATIVE: 'Creative-Version',
  FUNNEL: 'Funnel-Version',
  EXPERIMENT_ARM: 'Experimentarm',
};

const DESCRIPTIONS_DE: Readonly<Record<RollupDimension, string>> = {
  CAMPAIGN: 'Auslieferung, Leads und CRM-Ergebnisse je Kampagne.',
  CREATIVE:
    'Je ausgelieferter Creative-Version. Die Auslieferung steuert Meta — Unterschiede sind keine randomisierten Testergebnisse.',
  FUNNEL: 'Je veröffentlichter Funnel-Version.',
  EXPERIMENT_ARM: 'Je Arm eines laufenden oder abgeschlossenen Experiments.',
};

export interface BreakdownTabsProps {
  breakdowns: readonly Breakdown[];
}

/**
 * The four rollup dimensions as tabs.
 *
 * Each tab shows the same slice from a different angle: a single-hue spend chart
 * for the shape, and the full metric table — every rate with its basis, its
 * maturity and its attribution coverage — for the decision.
 */
export function BreakdownTabs({ breakdowns }: BreakdownTabsProps): React.JSX.Element {
  const first = breakdowns[0]?.dimension ?? 'CAMPAIGN';

  const renderArmLink = React.useCallback((row: BreakdownRow) => {
    if (!row.experimentId) return row.labelDe;
    return (
      <Link
        href={`/experimente/${row.experimentId}`}
        className="underline underline-offset-2 hover:text-brand"
      >
        {row.labelDe}
      </Link>
    );
  }, []);

  return (
    <Tabs defaultValue={first}>
      <TabsList aria-label="Aufschlüsselung nach Dimension">
        {breakdowns.map((breakdown) => (
          <TabsTrigger key={breakdown.dimension} value={breakdown.dimension}>
            {ROLLUP_DIMENSION_LABELS_DE[breakdown.dimension]}
          </TabsTrigger>
        ))}
      </TabsList>

      {breakdowns.map((breakdown) => (
        <TabsContent key={breakdown.dimension} value={breakdown.dimension}>
          <Section
            heading={ROLLUP_DIMENSION_LABELS_DE[breakdown.dimension]}
            headingLevel={3}
            description={DESCRIPTIONS_DE[breakdown.dimension]}
          >
            <BreakdownBarChart
              titleDe={`Spend je ${ENTITY_LABELS_DE[breakdown.dimension]}`}
              descriptionDe="Eine Kennzahl, eine Farbe. Die Identität trägt die Achsenbeschriftung, nicht die Farbe."
              rows={breakdown.rows}
            />
            <BreakdownTable
              rows={breakdown.rows}
              entityLabelDe={ENTITY_LABELS_DE[breakdown.dimension]}
              captionDe={`Kennzahlen je ${ENTITY_LABELS_DE[breakdown.dimension]} mit Bezugsgröße, Datenreife und Attributionsabdeckung`}
              renderLink={breakdown.dimension === 'EXPERIMENT_ARM' ? renderArmLink : undefined}
            />
          </Section>
        </TabsContent>
      ))}
    </Tabs>
  );
}
