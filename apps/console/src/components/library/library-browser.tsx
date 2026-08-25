'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ATTRIBUTION_LEVEL_LABELS_DE,
  CREATIVE_PRINCIPLES,
  OFFER_TYPE_LABELS_DE,
  type CreativePrinciple,
} from '@am/domain';
import {
  AttributionCoverageBadge,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfidenceBadge,
  DataMaturityBadge,
  EmptyState,
  FormFieldRow,
  Input,
  Section,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@am/ui';
import { Search } from 'lucide-react';
import { formatCurrencyMinor, formatNumber } from '@/lib/format';
import type { LibraryClaim, LibrarySnapshot } from '@/server/ops-port';
import {
  EMPTY_LIBRARY_FILTERS,
  PERFORMANCE_FILTERS,
  PERFORMANCE_FILTER_LABELS_DE,
  angleOptions,
  filterLibrary,
  offerOptions,
  type LibraryFilters,
} from './library-search';

/**
 * The library — everything the campaign pipeline is allowed to draw on.
 *
 * Two rules drive the presentation: every claim shows either its evidence or
 * the word „Hypothese“, and every performance figure shows its data maturity
 * and attribution level, so nothing here can be read as a harder fact than it
 * is.
 */

export const CREATIVE_PRINCIPLE_LABELS_DE: Readonly<Record<CreativePrinciple, string>> = {
  PROBLEM_PAIN: 'Problem / Schmerz',
  CONCRETE_RESULT: 'Konkretes Ergebnis',
  COMPARISON_ALTERNATIVE: 'Vergleich / Alternative',
  PROOF_CASE_DATAPOINT: 'Beleg / Case / Datenpunkt',
  OBJECTION_HANDLING: 'Einwandbehandlung',
  CONTRARIAN_INSIGHT: 'Konträre Einsicht',
};

const selectClass =
  'h-9 w-full rounded-md border border-input bg-surface px-2 text-sm text-foreground shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export const LIBRARY_TABS = [
  'creatives',
  'angles',
  'offers',
  'claims',
  'proof',
  'faqs',
  'guardrails',
  'history',
] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

export interface LibraryBrowserProps {
  snapshot: LibrarySnapshot;
  /** Which area opens first. Kept as a prop so a link can point at one. */
  defaultTab?: LibraryTab;
}

export function LibraryBrowser({ snapshot, defaultTab = 'creatives' }: LibraryBrowserProps) {
  const [filters, setFilters] = React.useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const filtered = React.useMemo(() => filterLibrary(snapshot, filters), [snapshot, filters]);
  const angles = React.useMemo(() => angleOptions(snapshot), [snapshot]);
  const offers = React.useMemo(() => offerOptions(snapshot), [snapshot]);

  const patch = (next: Partial<LibraryFilters>) =>
    setFilters((current) => ({ ...current, ...next }));

  return (
    <div className="flex flex-col gap-6">
      <Section
        heading="Suche und Filter"
        description="Die Suche greift auf alle Bereiche zu; die Filter wirken auf Creatives und historische Kampagnen."
        bordered
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <FormFieldRow
            label="Suche"
            help={`${formatNumber(filtered.counts.total)} Treffer in der gesamten Library`}
            className="md:col-span-2 xl:col-span-1"
          >
            {({ id, describedBy }) => (
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  className="pl-9"
                  type="search"
                  placeholder="z. B. Förderung"
                  value={filters.query}
                  onChange={(event) => patch({ query: event.target.value })}
                />
              </div>
            )}
          </FormFieldRow>

          <FormFieldRow label="Prinzip">
            {({ id }) => (
              <select
                id={id}
                className={selectClass}
                value={filters.principle}
                onChange={(event) =>
                  patch({ principle: event.target.value as LibraryFilters['principle'] })
                }
              >
                <option value="ALL">Alle Prinzipien</option>
                {CREATIVE_PRINCIPLES.map((principle) => (
                  <option key={principle} value={principle}>
                    {CREATIVE_PRINCIPLE_LABELS_DE[principle]}
                  </option>
                ))}
              </select>
            )}
          </FormFieldRow>

          <FormFieldRow label="Angle">
            {({ id }) => (
              <select
                id={id}
                className={selectClass}
                value={filters.angle}
                onChange={(event) => patch({ angle: event.target.value })}
              >
                <option value="ALL">Alle Angles</option>
                {angles.map((angle) => (
                  <option key={angle} value={angle}>
                    {angle}
                  </option>
                ))}
              </select>
            )}
          </FormFieldRow>

          <FormFieldRow label="Offer">
            {({ id }) => (
              <select
                id={id}
                className={selectClass}
                value={filters.offer}
                onChange={(event) => patch({ offer: event.target.value })}
              >
                <option value="ALL">Alle Offers</option>
                {offers.map((offer) => (
                  <option key={offer} value={offer}>
                    {offer}
                  </option>
                ))}
              </select>
            )}
          </FormFieldRow>

          <FormFieldRow label="Performance">
            {({ id }) => (
              <select
                id={id}
                className={selectClass}
                value={filters.performance}
                onChange={(event) =>
                  patch({ performance: event.target.value as LibraryFilters['performance'] })
                }
              >
                {PERFORMANCE_FILTERS.map((value) => (
                  <option key={value} value={value}>
                    {PERFORMANCE_FILTER_LABELS_DE[value]}
                  </option>
                ))}
              </select>
            )}
          </FormFieldRow>
        </div>
      </Section>

      <Tabs defaultValue={defaultTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="creatives">Creatives ({filtered.counts.creatives})</TabsTrigger>
          <TabsTrigger value="angles">Angles ({filtered.counts.angles})</TabsTrigger>
          <TabsTrigger value="offers">Offers ({filtered.counts.offers})</TabsTrigger>
          <TabsTrigger value="claims">Claims ({filtered.counts.claims})</TabsTrigger>
          <TabsTrigger value="proof">
            Belege ({filtered.counts.caseStudies + filtered.counts.testimonials})
          </TabsTrigger>
          <TabsTrigger value="faqs">FAQ ({filtered.counts.faqs})</TabsTrigger>
          <TabsTrigger value="guardrails">Guardrails ({filtered.counts.guardrails})</TabsTrigger>
          <TabsTrigger value="history">
            Historische Kampagnen ({filtered.counts.historicalCampaigns})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="creatives">
          {filtered.creatives.length === 0 ? (
            <NoResults area="Creative" />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {filtered.creatives.map((creative) => (
                <Card key={creative.id} className="h-full">
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="outline" size="sm">
                        {CREATIVE_PRINCIPLE_LABELS_DE[creative.principle]}
                      </Badge>
                      <StatusBadge kind="assetReview" state={creative.reviewState} size="sm" />
                    </div>
                    <CardTitle className="text-sm">
                      <DetailLink href={creative.href}>{creative.nameDe}</DetailLink>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <p className="text-sm font-medium text-foreground">{creative.hookDe}</p>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {creative.bodyDe}
                    </p>

                    <div className="flex flex-wrap gap-1.5">
                      {creative.renditions.map((rendition) => (
                        <Badge
                          key={rendition.aspectRatio}
                          size="sm"
                          tone={
                            rendition.status === 'READY'
                              ? 'success'
                              : rendition.status === 'PENDING'
                                ? 'warning'
                                : 'destructive'
                          }
                        >
                          {rendition.aspectRatio} · {rendition.width}×{rendition.height} ·{' '}
                          {rendition.status === 'READY'
                            ? 'fertig'
                            : rendition.status === 'PENDING'
                              ? 'in Arbeit'
                              : 'fehlgeschlagen'}
                        </Badge>
                      ))}
                    </div>

                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md bg-surface-sunken px-3 py-2.5 text-sm sm:grid-cols-4">
                      <div>
                        <dt className="text-xs text-muted-foreground">Ausgaben</dt>
                        <dd className="tabular-nums">
                          {formatCurrencyMinor(
                            creative.performance.spendMinor,
                            creative.performance.currency,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Impressionen</dt>
                        <dd className="tabular-nums">
                          {formatNumber(creative.performance.impressions)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Leads</dt>
                        <dd className="tabular-nums">{formatNumber(creative.performance.leads)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">CPL</dt>
                        <dd className="tabular-nums">
                          {formatCurrencyMinor(
                            creative.performance.costPerLeadMinor,
                            creative.performance.currency,
                          )}
                        </dd>
                      </div>
                    </dl>

                    <div className="flex flex-wrap items-center gap-2">
                      <DataMaturityBadge maturity={creative.performance.maturity} />
                      <Badge tone="neutral" size="sm">
                        {ATTRIBUTION_LEVEL_LABELS_DE[creative.performance.attributionLevel]}
                      </Badge>
                    </div>

                    {creative.claims.length > 0 ? (
                      <ul className="flex flex-col gap-2 border-t border-border pt-3">
                        {creative.claims.map((claim) => (
                          <li key={claim.id}>
                            <ClaimLine claim={claim} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="angles">
          {filtered.angles.length === 0 ? (
            <NoResults area="Angle" />
          ) : (
            <div className="flex flex-col gap-4">
              {filtered.angles.map((angle) => (
                <Card key={angle.id}>
                  <CardHeader>
                    <CardTitle className="text-sm">
                      <DetailLink href={angle.href}>{angle.nameDe}</DetailLink>
                    </CardTitle>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {angle.coreMessageDe}
                    </p>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <p className="text-xs text-muted-foreground">
                      Zielgruppe: {angle.audienceDe} · in {formatNumber(angle.usedInCampaigns)}{' '}
                      Kampagne(n) verwendet
                    </p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Version</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Zusammenfassung</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {angle.versions.map((version) => (
                          <TableRow key={version.version}>
                            <TableCell className="tabular-nums">v{version.version}</TableCell>
                            <TableCell>
                              <StatusBadge
                                kind="funnelVersion"
                                state={version.status}
                                size="sm"
                              />
                            </TableCell>
                            <TableCell>{version.summaryDe}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="offers">
          {filtered.offers.length === 0 ? (
            <NoResults area="Offer" />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {filtered.offers.map((offer) => (
                <Card key={offer.id}>
                  <CardHeader>
                    <Badge tone="outline" size="sm">
                      {OFFER_TYPE_LABELS_DE[offer.type]}
                    </Badge>
                    <CardTitle className="text-sm">
                      <DetailLink href={offer.href}>{offer.nameDe}</DetailLink>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 text-sm">
                    <p className="leading-relaxed text-muted-foreground">{offer.promiseDe}</p>
                    <p className="text-xs text-muted-foreground">
                      Aufwandsversprechen: {offer.effortPromiseDe ?? 'nicht hinterlegt'} · in{' '}
                      {formatNumber(offer.usedInCampaigns)} Kampagne(n) verwendet
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="claims">
          {filtered.claims.length === 0 ? (
            <NoResults area="Claim" />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="claim-list">
              {filtered.claims.map((claim) => (
                <li
                  key={claim.id}
                  className="rounded-lg border border-border bg-surface px-4 py-3.5"
                >
                  <ClaimLine claim={claim} />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="proof">
          <div className="flex flex-col gap-6">
            <Section heading="Case Studies">
              {filtered.caseStudies.length === 0 ? (
                <NoResults area="Case Study" />
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  {filtered.caseStudies.map((study) => (
                    <Card key={study.id}>
                      <CardHeader>
                        <div className="flex flex-wrap gap-2">
                          <Badge tone={study.approved ? 'success' : 'warning'} size="sm">
                            {study.approved ? 'Freigegeben' : 'Nicht freigegeben'}
                          </Badge>
                          <Badge tone={study.usableInAds ? 'info' : 'neutral'} size="sm">
                            {study.usableInAds ? 'In Anzeigen nutzbar' : 'Nicht in Anzeigen'}
                          </Badge>
                        </div>
                        <CardTitle className="text-sm">{study.clientDe}</CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-2 text-sm">
                        <p className="text-muted-foreground">{study.challengeDe}</p>
                        <p>{study.outcomeDe}</p>
                        <dl className="flex flex-wrap gap-3 text-xs">
                          {study.metrics.map((metric) => (
                            <div key={metric.labelDe} className="rounded-md bg-surface-sunken px-2 py-1">
                              <dt className="text-muted-foreground">{metric.labelDe}</dt>
                              <dd className="font-medium tabular-nums">{metric.valueDe}</dd>
                            </div>
                          ))}
                        </dl>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </Section>

            <Section heading="Testimonials">
              {filtered.testimonials.length === 0 ? (
                <NoResults area="Testimonial" />
              ) : (
                <ul className="flex flex-col gap-2">
                  {filtered.testimonials.map((testimonial) => (
                    <li
                      key={testimonial.id}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3.5"
                    >
                      <blockquote className="text-sm leading-relaxed text-foreground">
                        „{testimonial.quoteDe}“
                      </blockquote>
                      <p className="text-xs text-muted-foreground">
                        {testimonial.authorDe}
                        {testimonial.companyDe ? `, ${testimonial.companyDe}` : ''}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Badge tone={testimonial.approved ? 'success' : 'warning'} size="sm">
                          {testimonial.approved ? 'Freigegeben' : 'Nicht freigegeben'}
                        </Badge>
                        <Badge tone={testimonial.usableInAds ? 'info' : 'neutral'} size="sm">
                          {testimonial.usableInAds ? 'In Anzeigen nutzbar' : 'Nicht in Anzeigen'}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </TabsContent>

        <TabsContent value="faqs">
          {filtered.faqs.length === 0 ? (
            <NoResults area="FAQ" />
          ) : (
            <ul className="flex flex-col gap-2">
              {filtered.faqs.map((faq) => (
                <li key={faq.id} className="rounded-lg border border-border bg-surface px-4 py-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground">{faq.questionDe}</p>
                    <Badge tone={faq.approved ? 'success' : 'warning'} size="sm">
                      {faq.approved ? 'Freigegeben' : 'Nicht freigegeben'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {faq.answerDe}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="guardrails">
          {filtered.guardrails.length === 0 ? (
            <NoResults area="Guardrail" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Art</TableHead>
                  <TableHead>Muster</TableHead>
                  <TableHead>Begründung</TableHead>
                  <TableHead>Schwere</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.guardrails.map((guardrail) => (
                  <TableRow key={guardrail.id}>
                    <TableCell>{guardrail.kindDe}</TableCell>
                    <TableCell className="font-mono text-xs">{guardrail.pattern}</TableCell>
                    <TableCell>{guardrail.reasonDe}</TableCell>
                    <TableCell>
                      <Badge
                        tone={guardrail.severity === 'BLOCK' ? 'destructive' : 'warning'}
                        size="sm"
                      >
                        {guardrail.severity === 'BLOCK' ? 'Blockiert' : 'Warnt'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="history">
          {filtered.historicalCampaigns.length === 0 ? (
            <NoResults area="historische Kampagne" />
          ) : (
            <div className="flex flex-col gap-4">
              {filtered.historicalCampaigns.map((campaign) => (
                <Card key={campaign.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral" size="sm">
                        {ATTRIBUTION_LEVEL_LABELS_DE[campaign.attributionLevel]}
                      </Badge>
                      <DataMaturityBadge maturity={campaign.maturity} />
                      <ConfidenceBadge confidence={campaign.confidence} />
                      <AttributionCoverageBadge coverage={campaign.attributionCoverage} />
                    </div>
                    <CardTitle className="text-sm">
                      <DetailLink href={campaign.href}>{campaign.nameDe}</DetailLink>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 text-sm">
                    <p className="text-xs text-muted-foreground">
                      {campaign.periodDe} ·{' '}
                      {formatCurrencyMinor(campaign.spendMinor, campaign.currency)} Ausgaben ·{' '}
                      Angle: {campaign.angleNameDe ?? 'nicht hinterlegt'} · Offer:{' '}
                      {campaign.offerNameDe ?? 'nicht hinterlegt'}
                    </p>
                    <p className="leading-relaxed">{campaign.outcomeDe}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * A claim never appears without its backing. Either the evidence is named, or
 * the claim is labelled as a hypothesis — there is no third rendering.
 */
function ClaimLine({ claim }: { claim: LibraryClaim }) {
  return (
    <div className="flex flex-col gap-1.5" data-claim={claim.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm leading-relaxed text-foreground">{claim.textDe}</p>
        <ConfidenceBadge confidence={claim.confidence} />
      </div>
      {claim.evidence ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-semibold">Beleg ({claim.evidence.kindDe}): </span>
          {claim.evidence.summaryDe}
          {claim.evidence.sourceRefDe ? ` · Quelle: ${claim.evidence.sourceRefDe}` : ''}
          {claim.evidence.approved ? '' : ' · noch nicht freigegeben'}
        </p>
      ) : (
        <p className="text-xs leading-relaxed text-warning-foreground">
          <span className="font-semibold">Hypothese: </span>
          Für diese Aussage liegt kein Beleg vor. Sie darf nur als Hypothese gekennzeichnet
          verwendet werden.
        </p>
      )}
    </div>
  );
}

/**
 * A name is a link only when a detail route actually exists for it. A link
 * pointing at a route that is not there is a dead button (AGENTS.md rule 8).
 */
function DetailLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <Link href={href} className="hover:underline">
      {children}
    </Link>
  );
}

function NoResults({ area }: { area: string }) {
  return (
    <EmptyState
      size="sm"
      title={`Kein ${area} passt zu dieser Suche.`}
      description="Suchbegriff kürzen oder Filter zurücksetzen."
    />
  );
}
