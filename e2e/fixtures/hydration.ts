import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Waits until a React island on a server-rendered page has attached its
 * handlers.
 *
 * The console renders on the server, so a button is clickable — visible,
 * enabled, hit-testable — a measurable moment before it does anything. A click
 * in that window is swallowed whole, and no amount of auto-waiting notices,
 * because every actionability check already passed. Pressing "Als neuen Entwurf
 * bearbeiten" then does nothing at all.
 *
 * The gate is a control whose `aria-expanded` only flips in the browser, driven
 * through `expect(...).toPass()`: click, look for the effect, and click again if
 * it never came. That is a retry on a real condition rather than a guessed
 * duration, so it stays honest on a slow machine and costs one click on a fast
 * one.
 */

const OPEN_TIMEOUT_MS = 1_500;

async function toggleUntil(
  toggle: Locator,
  expanded: 'true' | 'false',
  close?: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    if (close && expanded === 'false') await close();
    else await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', expanded, {
      timeout: OPEN_TIMEOUT_MS,
    });
  }).toPass({ timeout: 30_000 });
}

export async function waitForInteractive(toggle: Locator): Promise<void> {
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggleUntil(toggle, 'true');
  /* Leave the page as it was found. */
  await toggleUntil(toggle, 'false');
}

/**
 * The same gate for any console page: the account menu lives in the shell, so
 * it is on every screen, and React hydrates the tree in one pass — once it
 * answers, the page below it answers too.
 *
 * Located by CSS rather than by role, because the open menu hides the rest of
 * the document from the accessibility tree, which would take the trigger with
 * it. Closed with Escape rather than a second click, because the same overlay
 * suppresses pointer events on everything behind it.
 */
export async function waitForConsoleReady(page: Page): Promise<void> {
  const trigger = page.locator('button[aria-label="Konto und Rollen"]');
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await toggleUntil(trigger, 'true');
  await toggleUntil(trigger, 'false', async () => {
    await page.keyboard.press('Escape');
  });
}
