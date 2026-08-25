import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS_TAB, SETTINGS_TABS, isSettingsTab, resolveSettingsTab } from './tabs';

describe('resolveSettingsTab', () => {
  it('opens the requested tab', () => {
    expect(resolveSettingsTab('compliance')).toBe('compliance');
    expect(resolveSettingsTab('flags')).toBe('flags');
  });

  it('falls back to the default rather than an empty screen', () => {
    // „Heute“, the budget refusal and the integration wizards all deep-link
    // here; a stale or hand-edited link must still land somewhere useful.
    expect(resolveSettingsTab(undefined)).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab(null)).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('')).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('gibt-es-nicht')).toBe(DEFAULT_SETTINGS_TAB);
  });

  it('accepts every declared tab and nothing else', () => {
    for (const tab of SETTINGS_TABS) {
      expect(isSettingsTab(tab.id)).toBe(true);
      expect(resolveSettingsTab(tab.id)).toBe(tab.id);
    }
    expect(isSettingsTab('users ')).toBe(false);
    expect(isSettingsTab(0)).toBe(false);
  });
});

describe('SETTINGS_TABS', () => {
  it('carries a unique id and a German label for every tab', () => {
    expect(SETTINGS_TABS.length).toBeGreaterThan(0);
    expect(new Set(SETTINGS_TABS.map((tab) => tab.id)).size).toBe(SETTINGS_TABS.length);
    for (const tab of SETTINGS_TABS) expect(tab.labelDe.trim()).not.toBe('');
  });

  it('covers the tabs other surfaces deep-link to', () => {
    const ids = SETTINGS_TABS.map((tab) => tab.id);
    expect(ids).toContain('compliance');
    expect(ids).toContain('flags');
    expect(ids).toContain(DEFAULT_SETTINGS_TAB);
  });
});
