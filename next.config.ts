import { withWorkflow } from 'workflow/next';
import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  // TypeScript 7 runs before Next via check:vercel.
  typescript: { ignoreBuildErrors: true, tsconfigPath: 'tsconfig.vercel.json' },
  async rewrites() {
    return [{ source: '/', destination: '/index.html' }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ] }];
  },
};

export default withWorkflow(config);
