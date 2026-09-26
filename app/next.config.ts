import path from 'node:path';
import type { NextConfig } from 'next';

// The app imports pure helpers from ../services/src (price math, EIP-712 attestation types) and reads
// ../deployments + ../abis at runtime, so Turbopack's root is the repo root.
const nextConfig: NextConfig = {
  turbopack: { root: path.resolve(process.cwd(), '..') },
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  reactStrictMode: true,
};

export default nextConfig;
