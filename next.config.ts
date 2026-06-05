import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,

  // Server-only deps that must be required at runtime, NOT bundled
  // by Turbopack. The PDF parser (lib/cv/parser.ts) imports
  // `pdf-parse` v2, which internally requires `pdfjs-dist` and its
  // web-worker shim. Turbopack doesn't know how to resolve the
  // `pdf.worker.mjs` chunk (it lives inside `node_modules/pdfjs-dist/
  // build/` and isn't reachable via the regular module graph), so
  // the build emits a `Cannot find module 'pdf.worker.mjs'` runtime
  // error the first time we try to parse a PDF. Marking the package
  // external here tells Next.js to load it via plain Node `require`
  // at runtime, which uses the on-disk worker file directly.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
