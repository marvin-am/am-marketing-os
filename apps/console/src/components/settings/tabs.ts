/**
 * The settings tabs and the `?tab=` deep link that selects one.
 *
 * This is deliberately a module of its own, without a `'use client'` directive.
 * `/einstellungen` is a server component and has to validate the query
 * parameter before it renders. A `'use client'` module's exports do not cross
 * the server boundary as values — the bundler replaces them with client
 * references — so a server component that read this list from
 * `settings-view.tsx` would get a proxy instead of an array and fail on the
 * first method call. Keeping the list here lets both sides import the real
 * value.
 *
 * The German labels live here too, so the tab strip and the set of valid deep
 * link targets cannot drift apart: a tab that is reachable by URL always has a
 * trigger, and vice versa.
 */

export interface SettingsTabDefinition {
  readonly id: string;
  readonly labelDe: string;
}

export const SETTINGS_TABS = [
  { id: 'users', labelDe: 'Nutzer und Rollen' },
  { id: 'limits', labelDe: 'Limits und Freigaben' },
  { id: 'decisions', labelDe: 'Entscheidungsregeln' },
  { id: 'compliance', labelDe: 'Einwilligung und Aufbewahrung' },
  { id: 'brand', labelDe: 'Marke' },
  { id: 'flags', labelDe: 'Feature-Flags' },
] as const satisfies readonly SettingsTabDefinition[];

export type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'users';

export function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}

/**
 * Resolves the tab a deep link asks for. An unknown or absent value opens the
 * default tab rather than an empty screen — „Heute“, the budget refusal and the
 * integration wizards all link here, and a stale link should still land
 * somewhere useful.
 */
export function resolveSettingsTab(value: string | null | undefined): SettingsTab {
  return isSettingsTab(value) ? value : DEFAULT_SETTINGS_TAB;
}
