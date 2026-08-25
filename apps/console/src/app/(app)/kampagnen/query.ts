import { campaignStateSchema, type CampaignState } from '@am/domain';
import type { CampaignListQuery } from '@/server/campaign-port';

/**
 * URL ⇄ query translation for the campaign list.
 *
 * Pure and shared by the page and its tests, so "what the URL means" has one
 * definition. Every filter lives in the URL: a filtered list is linkable and
 * the browser's back button behaves.
 */

export const DEFAULT_PAGE_SIZE = 10;

export type RawSearchParams = Record<string, string | string[] | undefined>;

function values(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((v) => v.trim()).filter((v) => v !== '');
}

function single(raw: string | string[] | undefined): string | null {
  return values(raw)[0] ?? null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseCampaignQuery(params: RawSearchParams): CampaignListQuery {
  const states = values(params.status).flatMap((value) => {
    const parsed = campaignStateSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });

  const from = single(params.von);
  const to = single(params.bis);
  const pageRaw = Number.parseInt(single(params.seite) ?? '1', 10);

  return {
    states,
    angles: values(params.angle),
    offers: values(params.offer),
    from: from && ISO_DATE.test(from) ? from : null,
    to: to && ISO_DATE.test(to) ? to : null,
    search: single(params.q),
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

/** True when the operator narrowed the list — drives which empty state shows. */
export function isFiltered(query: CampaignListQuery): boolean {
  return (
    query.states.length > 0 ||
    query.angles.length > 0 ||
    query.offers.length > 0 ||
    query.from !== null ||
    query.to !== null ||
    (query.search ?? '') !== ''
  );
}

export function buildCampaignHref(query: CampaignListQuery, page: number): string {
  const search = new URLSearchParams();
  for (const state of query.states) search.append('status', state);
  for (const angle of query.angles) search.append('angle', angle);
  for (const offer of query.offers) search.append('offer', offer);
  if (query.search) search.set('q', query.search);
  if (query.from) search.set('von', query.from);
  if (query.to) search.set('bis', query.to);
  if (page > 1) search.set('seite', String(page));
  const qs = search.toString();
  return qs === '' ? '/kampagnen' : `/kampagnen?${qs}`;
}

export function describeQueryDe(query: CampaignListQuery, states: CampaignState[]): string {
  const parts: string[] = [];
  if (states.length > 0) parts.push(`${states.length} Status`);
  if (query.angles.length > 0) parts.push(`Angle „${query.angles[0]}"`);
  if (query.offers.length > 0) parts.push(`Offer „${query.offers[0]}"`);
  if (query.from) parts.push(`ab ${query.from}`);
  if (query.to) parts.push(`bis ${query.to}`);
  return parts.length === 0 ? 'Kein Filter aktiv.' : `Gefiltert nach ${parts.join(', ')}.`;
}
