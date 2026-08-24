import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '..');
const withMDX = createMDX();

const nextConfig: NextConfig = {
  turbopack: {
    root: repoRoot,
  },
  async redirects() {
    return [
      {
        source: '/docs/foundations',
        destination: '/docs/foundations/overview',
        permanent: true,
      },
    ];
  },
};

export default withMDX(nextConfig);
