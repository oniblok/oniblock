import path from 'node:path';
import type { NextConfig } from 'next';

// The app imports pure helpers from ../services/src (price math, EIP-712 attestation types) and reads
// ../deployments + ../abis at runtime, so Turbopack's root is the repo root.
const nextConfig: NextConfig = {
  // NEXT_DIST_DIR lets a verification build (`NEXT_DIST_DIR=.next-check pnpm build`) run next to a live `next start`
  // without rewriting the .next it serves.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  turbopack: { root: path.resolve(process.cwd(), '..') },
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  reactStrictMode: true,
};

export default nextConfig;
