'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@am/ui';
import {
  CAMPAIGN_TAB_LABELS_DE,
  CAMPAIGN_TABS,
  campaignTabHref,
  type CampaignTab,
} from '@/server/campaign-port';

/**
 * Every tab is its own route segment, so each one is linkable, bookmarkable and
 * shareable. This is a navigation list, not a `Tabs` widget: the panels are
 * separate documents.
 */
export function CampaignTabs({ campaignId }: { campaignId: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Bereiche dieser Kampagne" className="border-b border-border">
      <ul className="-mb-px flex flex-wrap gap-x-1 gap-y-0.5 overflow-x-auto">
        {CAMPAIGN_TABS.map((tab) => {
          const href = campaignTabHref(campaignId, tab);
          const active = isTabActive(pathname, href);
          return (
            <li key={tab}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                data-campaign-tab={tab}
                className={cn(
                  'inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium',
                  'transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                  active
                    ? 'border-brand text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground',
                )}
              >
                {CAMPAIGN_TAB_LABELS_DE[tab]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function isTabActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function tabFromPathname(pathname: string): CampaignTab | null {
  const segment = pathname.split('/').filter(Boolean).at(2);
  return CAMPAIGN_TABS.find((tab) => tab === segment) ?? null;
}
