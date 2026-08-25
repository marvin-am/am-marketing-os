'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  FlaskConical,
  LayoutGrid,
  Lightbulb,
  Plug,
  Settings,
  Sun,
  TrendingUp,
} from 'lucide-react';
import { SidebarNav, SidebarNavGroup, SidebarNavItem } from '@am/ui';
import { NAVIGATION, isNavEntryActive, type NavIcon } from './navigation';

const ICONS: Record<NavIcon, React.ComponentType<{ className?: string }>> = {
  today: Sun,
  campaigns: LayoutGrid,
  experiments: FlaskConical,
  performance: TrendingUp,
  learnings: Lightbulb,
  library: BookOpen,
  integrations: Plug,
  settings: Settings,
};

export interface SidebarProps {
  /** Counts rendered as badges, keyed by href. Omitted keys render no badge. */
  badges?: Record<string, number | undefined>;
}

export function Sidebar({ badges = {} }: SidebarProps) {
  const pathname = usePathname() ?? '/heute';

  return (
    <SidebarNav label="Hauptnavigation" className="px-2">
      {NAVIGATION.map((group, index) => (
        <SidebarNavGroup key={group.labelDe ?? `group-${index}`} label={group.labelDe}>
          {group.entries.map((entry) => {
            const Icon = ICONS[entry.icon];
            const count = badges[entry.href];
            return (
              <SidebarNavItem
                key={entry.href}
                asChild
                active={isNavEntryActive(pathname, entry.href)}
                icon={<Icon />}
                badge={count && count > 0 ? count : undefined}
              >
                <Link href={entry.href} title={entry.descriptionDe}>
                  {entry.labelDe}
                </Link>
              </SidebarNavItem>
            );
          })}
        </SidebarNavGroup>
      ))}
    </SidebarNav>
  );
}
