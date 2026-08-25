import type { Permission } from '@am/domain';

/**
 * The console's primary navigation (spec §8).
 *
 * Order is deliberate: the day starts at "Heute", work moves left to right
 * through campaigns and their results, and configuration sits at the bottom
 * where it is out of the daily path.
 */
export interface NavEntry {
  href: string;
  labelDe: string;
  /** Lucide icon name, resolved in the client component. */
  icon: NavIcon;
  /** Hidden entirely when the user lacks this permission. */
  permission: Permission;
  descriptionDe: string;
}

export type NavIcon =
  | 'today'
  | 'campaigns'
  | 'experiments'
  | 'performance'
  | 'learnings'
  | 'library'
  | 'integrations'
  | 'settings';

export interface NavGroup {
  labelDe?: string;
  entries: NavEntry[];
}

export const NAVIGATION: NavGroup[] = [
  {
    entries: [
      {
        href: '/heute',
        labelDe: 'Heute',
        icon: 'today',
        permission: 'campaign.read',
        descriptionDe: 'Offene Freigaben, Empfehlungen und Warnungen.',
      },
    ],
  },
  {
    labelDe: 'Arbeit',
    entries: [
      {
        href: '/kampagnen',
        labelDe: 'Kampagnen',
        icon: 'campaigns',
        permission: 'campaign.read',
        descriptionDe: 'Von der Idee bis zum pausierten Meta-Entwurf.',
      },
      {
        href: '/experimente',
        labelDe: 'Experimente',
        icon: 'experiments',
        permission: 'campaign.read',
        descriptionDe: 'Laufende und abgeschlossene Tests.',
      },
      {
        href: '/library',
        labelDe: 'Library',
        icon: 'library',
        permission: 'campaign.read',
        descriptionDe: 'Creatives, Angles, Offers und Belege.',
      },
    ],
  },
  {
    labelDe: 'Ergebnisse',
    entries: [
      {
        href: '/performance',
        labelDe: 'Performance',
        icon: 'performance',
        permission: 'campaign.read',
        descriptionDe: 'Spend, Leads, VQs, Abschlüsse, CAC und ROAS.',
      },
      {
        href: '/learnings',
        labelDe: 'Learnings',
        icon: 'learnings',
        permission: 'campaign.read',
        descriptionDe: 'Was gelernt wurde — und wie belastbar es ist.',
      },
    ],
  },
  {
    labelDe: 'Konfiguration',
    entries: [
      {
        href: '/integrationen',
        labelDe: 'Integrationen',
        icon: 'integrations',
        permission: 'campaign.read',
        descriptionDe: 'Meta, HubSpot, OpenAI und Supabase.',
      },
      {
        href: '/einstellungen',
        labelDe: 'Einstellungen',
        icon: 'settings',
        permission: 'campaign.read',
        descriptionDe: 'Rollen, Limits, Schwellen und Consent.',
      },
    ],
  },
];

/** Active-state matching: a section stays active on its detail routes. */
export function isNavEntryActive(pathname: string, href: string): boolean {
  if (href === '/heute') return pathname === '/' || pathname.startsWith('/heute');
  return pathname === href || pathname.startsWith(`${href}/`);
}
