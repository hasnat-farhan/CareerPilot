import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,

  // Server-only deps that must be required at runtime, NOT bundled
  // by Turbopack. `unpdf` bundles its own serverless pdfjs build
  // (DOMMatrix/OffscreenCanvas stripped, worker inlined). Marking it
  // external ensures Next.js loads it via plain Node `require` at
  // runtime rather than trying to tree-shake the bundled pdfjs.
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
