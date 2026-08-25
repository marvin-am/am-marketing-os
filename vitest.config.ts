import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Root Vitest workspace.
 *
 * - `unit`        — pure logic, no I/O, runs everywhere (node environment)
 * - `dom`         — React component tests (jsdom)
 * - `integration` — cross-package flows against fixture providers and, when
 *                   `DATABASE_URL` points at a Postgres test instance, against
 *                   real Postgres with RLS. Those suites skip themselves
 *                   cleanly when the variable is absent.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { tsconfigPaths: true },
        test: {
          name: 'unit',
          environment: 'node',
          globals: true,
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
        },
      },
      {
        plugins: [react()],
        resolve: { tsconfigPaths: true },
        test: {
          name: 'dom',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./vitest.setup.ts'],
          include: ['packages/*/src/**/*.test.tsx', 'apps/*/src/**/*.test.tsx'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
          /**
           * The builder tests drive genuine multi-step interactions —
           * add a step, reorder it, fill a branch, land on a result — and
           * `userEvent` waits for real timers between each one. Vitest's 5 s
           * default is comfortable in isolation and too tight once the whole
           * suite is competing for four cores, which produced tests that
           * passed alone and failed together. A test that only passes on an
           * idle machine is not a gate, so the budget matches the work.
           */
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        resolve: { tsconfigPaths: true },
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: [
            'packages/*/integration/**/*.test.ts',
            'supabase/tests/**/*.test.ts',
            'apps/*/integration/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
});
