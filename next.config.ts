import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // `pdf-parse` v2 wraps `pdfjs-dist`, which in Node tries to
  // dynamic-import a worker file at runtime. If Turbopack bundles
  // these, the relative `./pdf.worker.mjs` path that pdfjs defaults
  // to no longer points anywhere real, and you get
  //   "Setting up fake worker failed: Cannot find module
  //    './pdf.worker.mjs'"
  // at the first PDF parse. `lib/cv/parse.ts` overrides `workerSrc`
  // to a `file://` URL of the installed worker, but we still need
  // Turbopack to leave the packages alone so that override wins.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
