import type { NextConfig } from 'next';

/**
 * Public funnel runtime.
 *
 * Optimised for first paint on mobile: no analytics vendor bundle, no client
 * Supabase SDK, and published funnel specs are cached rather than re-read per
 * request.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@am/domain',
    '@am/config',
    '@am/db',
    '@am/ui',
    '@am/funnel-schema',
    '@am/tracking',
    '@am/experiments',
    '@am/meta',
    '@am/observability',
  ],
  poweredByHeader: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    formats: ['image/webp'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
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
