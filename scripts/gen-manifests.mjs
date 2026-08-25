#!/usr/bin/env node
/**
 * One-shot generator for workspace package manifests + tsconfigs.
 * Kept in the repo so the workspace graph stays reproducible and reviewable.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const W = 'workspace:*';

const V = {
  zod: '4.4.3',
  react: '19.2.8',
  reactDom: '19.2.8',
  next: '16.3.3',
  supabase: '2.112.4',
  supabaseSsr: '0.8.0',
  openai: '7.5.0',
  sharp: '0.35.3',
  recharts: '3.10.1',
  rhf: '7.86.0',
  hookformResolvers: '5.2.2',
  query: '5.102.3',
  dndCore: '6.3.1',
  dndSortable: '10.0.0',
  dndModifiers: '9.0.0',
  radix: '1.4.3',
  cva: '0.7.1',
  clsx: '2.1.1',
  twMerge: '3.4.1',
  lucide: '0.552.0',
  tailwind: '4.3.3',
  tailwindPostcss: '4.3.3',
  tailwindAnimate: '1.0.7',
  postcss: '8.5.6',
  pg: '8.16.3',
  dateFns: '4.1.0',
  playwright: '1.62.1',
  vaul: '1.1.2',
  sonner: '2.0.7',
};

/** @type {Array<{dir:string,name:string,deps?:Record<string,string>,devDeps?:Record<string,string>,app?:boolean,port?:number}>} */
const packages = [
  {
    dir: 'packages/domain',
    name: '@am/domain',
    deps: { zod: V.zod },
  },
  {
    dir: 'packages/config',
    name: '@am/config',
    deps: { zod: V.zod, '@am/domain': W },
  },
  {
    dir: 'packages/observability',
    name: '@am/observability',
    deps: { '@am/domain': W, '@am/config': W },
  },
  {
    dir: 'packages/db',
    name: '@am/db',
    deps: {
      '@supabase/supabase-js': V.supabase,
      '@supabase/ssr': V.supabaseSsr,
      '@am/domain': W,
      '@am/config': W,
      '@am/observability': W,
      zod: V.zod,
    },
    devDeps: { pg: V.pg, '@types/pg': '8.15.6' },
  },
  {
    dir: 'packages/funnel-schema',
    name: '@am/funnel-schema',
    deps: { zod: V.zod, '@am/domain': W },
  },
  {
    dir: 'packages/tracking',
    name: '@am/tracking',
    deps: { zod: V.zod, '@am/domain': W, '@am/config': W },
  },
  {
    dir: 'packages/experiments',
    name: '@am/experiments',
    deps: { zod: V.zod, '@am/domain': W },
  },
  {
    dir: 'packages/recommendations',
    name: '@am/recommendations',
    deps: { zod: V.zod, '@am/domain': W, '@am/experiments': W },
  },
  {
    dir: 'packages/ai',
    name: '@am/ai',
    deps: {
      openai: V.openai,
      zod: V.zod,
      '@am/domain': W,
      '@am/config': W,
      '@am/funnel-schema': W,
      '@am/observability': W,
    },
  },
  {
    dir: 'packages/creative-renderer',
    name: '@am/creative-renderer',
    deps: { sharp: V.sharp, '@am/domain': W, '@am/config': W, zod: V.zod },
  },
  {
    dir: 'packages/meta',
    name: '@am/meta',
    deps: { zod: V.zod, '@am/domain': W, '@am/config': W, '@am/observability': W },
  },
  {
    dir: 'packages/hubspot',
    name: '@am/hubspot',
    deps: { zod: V.zod, '@am/domain': W, '@am/config': W, '@am/observability': W },
  },
  {
    dir: 'packages/jobs',
    name: '@am/jobs',
    deps: {
      zod: V.zod,
      '@am/domain': W,
      '@am/config': W,
      '@am/db': W,
      '@am/meta': W,
      '@am/hubspot': W,
      '@am/experiments': W,
      '@am/recommendations': W,
      '@am/observability': W,
    },
  },
  {
    dir: 'packages/ui',
    name: '@am/ui',
    deps: {
      '@am/domain': W,
      'class-variance-authority': V.cva,
      clsx: V.clsx,
      'tailwind-merge': V.twMerge,
      'lucide-react': V.lucide,
      'radix-ui': V.radix,
      sonner: V.sonner,
      vaul: V.vaul,
    },
    devDeps: {
      react: V.react,
      'react-dom': V.reactDom,
      tailwindcss: V.tailwind,
    },
    peerDeps: { react: '^19', 'react-dom': '^19' },
  },
  {
    dir: 'apps/console',
    name: '@am/console',
    app: true,
    port: 3000,
    deps: {
      next: V.next,
      react: V.react,
      'react-dom': V.reactDom,
      '@am/domain': W,
      '@am/config': W,
      '@am/db': W,
      '@am/ui': W,
      '@am/ai': W,
      '@am/creative-renderer': W,
      '@am/funnel-schema': W,
      '@am/tracking': W,
      '@am/experiments': W,
      '@am/recommendations': W,
      '@am/meta': W,
      '@am/hubspot': W,
      '@am/jobs': W,
      '@am/observability': W,
      '@supabase/supabase-js': V.supabase,
      '@supabase/ssr': V.supabaseSsr,
      '@tanstack/react-query': V.query,
      'react-hook-form': V.rhf,
      '@hookform/resolvers': V.hookformResolvers,
      zod: V.zod,
      recharts: V.recharts,
      '@dnd-kit/core': V.dndCore,
      '@dnd-kit/sortable': V.dndSortable,
      '@dnd-kit/modifiers': V.dndModifiers,
      'date-fns': V.dateFns,
      clsx: V.clsx,
      'tailwind-merge': V.twMerge,
      'lucide-react': V.lucide,
      'radix-ui': V.radix,
      'class-variance-authority': V.cva,
      sonner: V.sonner,
    },
    devDeps: {
      tailwindcss: V.tailwind,
      '@tailwindcss/postcss': V.tailwindPostcss,
      postcss: V.postcss,
    },
  },
  {
    dir: 'apps/funnels',
    name: '@am/funnels',
    app: true,
    port: 3001,
    deps: {
      next: V.next,
      react: V.react,
      'react-dom': V.reactDom,
      '@am/domain': W,
      '@am/config': W,
      '@am/db': W,
      '@am/ui': W,
      '@am/funnel-schema': W,
      '@am/tracking': W,
      '@am/experiments': W,
      '@am/meta': W,
      '@am/observability': W,
      '@supabase/supabase-js': V.supabase,
      '@supabase/ssr': V.supabaseSsr,
      zod: V.zod,
      clsx: V.clsx,
      'tailwind-merge': V.twMerge,
      'lucide-react': V.lucide,
      'class-variance-authority': V.cva,
    },
    devDeps: {
      tailwindcss: V.tailwind,
      '@tailwindcss/postcss': V.tailwindPostcss,
      postcss: V.postcss,
    },
  },
];

for (const p of packages) {
  const dir = join(ROOT, p.dir);
  mkdirSync(dir, { recursive: true });

  const pkg = {
    name: p.name,
    version: '1.0.0',
    private: true,
    type: 'module',
    ...(p.app
      ? {}
      : {
          main: './src/index.ts',
          types: './src/index.ts',
          exports: {
            '.': './src/index.ts',
            './*': './src/*.ts',
          },
        }),
    scripts: p.app
      ? {
          dev: `next dev --port ${p.port}`,
          build: 'next build',
          start: `next start --port ${p.port}`,
          lint: 'eslint src --max-warnings 0',
          typecheck: 'tsc --noEmit',
        }
      : {
          build: 'echo "source package — consumed via transpilePackages"',
          lint: 'eslint src --max-warnings 0',
          typecheck: 'tsc --noEmit',
        },
    ...(p.deps ? { dependencies: p.deps } : {}),
    ...(p.devDeps ? { devDependencies: p.devDeps } : {}),
    ...(p.peerDeps ? { peerDependencies: p.peerDeps } : {}),
  };

  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const depth = p.dir.split('/').length;
  const up = '../'.repeat(depth);
  const tsconfig = p.app
    ? {
        extends: `${up}tsconfig.base.json`,
        compilerOptions: {
          jsx: 'preserve',
          noEmit: true,
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./src/*'] },
          types: ['node'],
        },
        include: [
          'next-env.d.ts',
          '**/*.ts',
          '**/*.tsx',
          '.next/types/**/*.ts',
          `${up}vitest.setup.ts`,
        ],
        exclude: ['node_modules', '.next'],
      }
    : {
        extends: `${up}tsconfig.base.json`,
        compilerOptions: { noEmit: true, types: ['node', 'vitest/globals'] },
        include: ['src/**/*', 'integration/**/*'],
        exclude: ['node_modules', 'dist'],
      };

  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
  console.log(`generated ${p.dir}`);
}

// e2e workspace package
mkdirSync(join(ROOT, 'e2e'), { recursive: true });
writeFileSync(
  join(ROOT, 'e2e/package.json'),
  JSON.stringify(
    {
      name: '@am/e2e',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: {
        test: 'playwright test',
        'test:ui': 'playwright test --ui',
        lint: 'eslint . --max-warnings 0',
        typecheck: 'tsc --noEmit',
        build: 'echo "e2e suite"',
      },
      dependencies: {
        '@am/domain': W,
        '@am/funnel-schema': W,
        '@am/db': W,
        '@am/config': W,
      },
      devDependencies: { '@playwright/test': V.playwright },
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  join(ROOT, 'e2e/tsconfig.json'),
  JSON.stringify(
    {
      extends: '../tsconfig.base.json',
      compilerOptions: { noEmit: true, types: ['node'] },
      include: ['**/*.ts'],
      exclude: ['node_modules'],
    },
    null,
    2,
  ) + '\n',
);
console.log('generated e2e');
