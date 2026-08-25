import type { NextConfig } from 'next';

/**
 * Console app — the internal marketing tool.
 *
 * Workspace packages are shipped as TypeScript source, so Next transpiles them
 * rather than consuming a build output. That keeps the monorepo free of a
 * library build step without giving up type safety.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@am/domain',
    '@am/config',
    '@am/db',
    '@am/ui',
    '@am/ai',
    '@am/creative-renderer',
    '@am/funnel-schema',
    '@am/tracking',
    '@am/experiments',
    '@am/recommendations',
    '@am/meta',
    '@am/hubspot',
    '@am/jobs',
    '@am/observability',
  ],
  /*
   * `pg` must not be bundled. `@am/db` loads the driver through `createRequire`
   * so nothing tries to resolve it in a browser build, but in the server bundle
   * `import.meta.url` resolves from `.next/server/…`, where pnpm's layout does
   * not expose the package's own `node_modules`. Left alone, the Supabase health
   * probe would report "driver unavailable" in production and never actually
   * check the database it claims to check.
   */
  serverExternalPackages: ['sharp', 'pg'],
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
