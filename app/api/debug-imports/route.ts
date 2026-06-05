/**
 * GET /api/debug-imports
 *
 * Diagnostic route that loads each suspected module and reports
 * whether the import succeeded. This isolates which transitive
 * dependency is throwing on the Netlify function cold start.
 *
 * DELETE THIS FILE once the real bug is fixed.
 *
 * Note: path is "debug-imports" (no leading underscore) because
 * Next.js excludes directories starting with "_" or "__" from
 * routing (they're treated as private folders).
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Result = { module: string; ok: boolean; error?: string };

async function tryImport(label: string, loader: () => Promise<unknown> | unknown): Promise<Result> {
  try {
    await loader();
    return { module: label, ok: true };
  } catch (e) {
    const err = e as Error;
    return {
      module: label,
      ok: false,
      error: (err?.message ?? String(e)).slice(0, 800),
    };
  }
}

export async function GET() {
  const results: Result[] = [];

  results.push(await tryImport("next/server",           () => import("next/server")));
  results.push(await tryImport("@clerk/nextjs/server",  () => import("@clerk/nextjs/server")));
  results.push(await tryImport("@supabase/supabase-js", () => import("@supabase/supabase-js")));
  results.push(await tryImport("@google/generative-ai", () => import("@google/generative-ai")));
  results.push(await tryImport("mammoth",               () => import("mammoth")));
  results.push(await tryImport("pdf-parse",             () => import("pdf-parse")));
  results.push(await tryImport("pdfjs-dist",            () => import("pdfjs-dist")));

  // Now load our own modules in dependency order.
  results.push(await tryImport("lib/supabase/admin",         () => import("@/lib/supabase/admin")));
  results.push(await tryImport("lib/auth/require-user",      () => import("@/lib/auth/require-user")));
  results.push(await tryImport("lib/ai/provider",            () => import("@/lib/ai/provider")));
  results.push(await tryImport("lib/cv/parser",              () => import("@/lib/cv/parser")));
  results.push(await tryImport("lib/cv/chunker",             () => import("@/lib/cv/chunker")));
  results.push(await tryImport("lib/cv/ingester",            () => import("@/lib/cv/ingester")));

  const failed = results.filter((r) => !r.ok);
  return NextResponse.json(
    {
      node: process.version,
      platform: process.platform,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        hasClerkPub: Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY),
        hasClerkSec: Boolean(process.env.CLERK_SECRET_KEY),
        hasSbUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
        hasSbSvc: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
        hasGemini: Boolean(process.env.GEMINI_API_KEY),
      },
      results,
      failed,
    },
    { status: 200 },
  );
}
