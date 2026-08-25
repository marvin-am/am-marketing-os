import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Root Vitest workspace.
 *
 * - `unit`        — pure logic, no I/O, runs everywhere (node environment)
 * - `dom`         — React component tests (jsdom)
 * - `integration` — cross-package flows against fixture providers and, when
 *                   `DATABASE_URL` points at a local Supabase test instance,
 *                   against real Postgres + RLS.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          name: 'unit',
          environment: 'node',
          globals: true,
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
        },
      },
      {
        plugins: [react(), tsconfigPaths()],
        test: {
          name: 'dom',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./vitest.setup.ts'],
          include: ['packages/*/src/**/*.test.tsx', 'apps/*/src/**/*.test.tsx'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: ['packages/*/integration/**/*.test.ts', 'supabase/tests/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
});
