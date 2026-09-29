import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // UI tests build into their own folder (scripts/build-e2e.mjs), so a test build never replaces the
  // production build live HQ serves from .next.
  distDir: process.env.JOS_HQ_DIST_DIR || ".next",
  // Local command center: SSE streams must not be buffered by response compression.
  compress: false,
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
