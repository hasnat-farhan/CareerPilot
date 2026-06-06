#!/usr/bin/env node
/**
 * Pillar 2 (Profile & Resume Intelligence) wiring smoke test.
 *
 * This is a hermetic, no-network test. It does NOT require a live Supabase,
 * Clerk, or Gemini. It only proves that the modules are wired correctly
 * across the RAG pipeline:
 *
 *   1. `lib/rag/retrieve-cv.ts` exports the `Citation` shape used by
 *      the rest of the system (and the same shape flows from the
 *      chat API back to the UI).
 *   2. `lib/agents/assistant.ts` calls the retriever in `general` mode
 *      and surfaces the returned citations on the AssistantResponse.
 *   3. `app/api/chat/threads/[id]/messages/route.ts` persists the
 *      citations into `chat_messages.citations` and serialises them
 *      back to the client.
 *   4. `app/api/cv/upload/route.ts` accepts only PDF and DOCX,
 *      creates a `cvs` row up-front, and ingests via the
 *      `replace_cv_chunks` RPC.
 *   5. `app/api/cv/list/route.ts` filters by user_id, orders by
 *      `created_at desc`, and returns the basic CV columns.
 *   6. `app/api/cv/[id]/route.ts` enforces ownership and deletes
 *      chunks before the row.
 *   7. `app/api/cv/[id]/chunks/route.ts` exposes the per-chunk list
 *      for the inspector.
 *   8. The migrations add the columns the routes read.
 *   9. The CV page UI calls the new list/detail/chunks/upload endpoints.
 *
 * For a real E2E (upload a PDF, confirm chunks appear, ask a question,
 * confirm the assistant cites the chunks) the user runs the manual
 * checklist in README.md or follows the steps in the dev env.
 *
 * Usage:
 *   node scripts/smoke-rag.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

function read(rel) {
  const path = resolve(ROOT, rel);
  if (!existsSync(path)) {
    throw new Error(`Missing required file: ${rel}`);
  }
  return readFileSync(path, "utf8");
}

// ---------- 1. RAG seam: Citation contract ----------

console.log("\n[1] RAG seam (lib/rag/retrieve-cv.ts)");
const retrieveCv = read("lib/rag/retrieve-cv.ts");

check(
  "exports `Citation` interface",
  /export interface Citation \{/.test(retrieveCv),
);
check(
  "Citation has `id` (UUID from cv_chunks.id)",
  /id:\s*string;/.test(retrieveCv),
);
check(
  "Citation has `source` (human label)",
  /source:\s*string;/.test(retrieveCv),
);
check(
  "Citation has `text` (chunk text verbatim)",
  /text:\s*string;/.test(retrieveCv),
);
check(
  "Citation has `score` (cosine in [0, 1])",
  /score:\s*number;/.test(retrieveCv),
);
check(
  "exports `retrieveCvChunks` (the seam function)",
  /export async function retrieveCvChunks\(/.test(retrieveCv),
);
check(
  "retriever calls `match_cv_chunks` RPC",
  /match_cv_chunks/.test(retrieveCv),
);
check(
  "retriever passes `p_user_id` to the RPC",
  /p_user_id:\s*userId/.test(retrieveCv),
);
check(
  "retriever embeds the query with embedText",
  /embedText\(query/.test(retrieveCv),
);
check(
  "retriever handles empty-result case (returns [])",
  /return \[\];/.test(retrieveCv),
);
check(
  "retriever maps RPC rows → Citation shape",
  /source:\s*row\.section_label\s*\?\?\s*row\.section/.test(retrieveCv),
);

// ---------- 2. Assistant: general mode wires the retriever ----------

console.log("\n[2] Assistant general mode (lib/agents/assistant.ts)");
const assistant = read("lib/agents/assistant.ts");

check(
  "exports `runAssistant(input, retrieveCvChunks)`",
  /export async function runAssistant\(\s*input: AssistantInput,\s*retrieveCvChunks:/.test(
    assistant,
  ),
);
check(
  "AssistantResponse (general mode) carries `citations`",
  /mode:\s*"general";\s*message:\s*string;\s*citations:/.test(assistant),
);
check(
  "`runGeneralChat` awaits `retrieveCvChunks(userId, message)`",
  /const citations = await retrieveCvChunks\(userId, message\);/.test(assistant),
);
check(
  "general mode attaches citations to the response",
  /return\s*\{\s*mode:\s*"general",\s*message:\s*reply,\s*citations\s*\};/.test(
    assistant,
  ),
);
check(
  "general-mode prompt asks model to cite [chunk-id]",
  /Cite CV chunks inline as \[chunk-id\]/.test(assistant),
);
check(
  "intent router short-circuits to general when no benchmark resolves",
  /if \(!benchmark\) \{\s*return runGeneralChat/.test(assistant),
);

// ---------- 3. Chat route: persist + return citations ----------

console.log(
  "\n[3] Chat API route (app/api/chat/threads/[id]/messages/route.ts)",
);
const chatRoute = read("app/api/chat/threads/[id]/messages/route.ts");

check(
  "route resolves Clerk user via requireUserId()",
  /userId = await requireUserId\(\);/.test(chatRoute),
);
check(
  "route validates thread ownership before dispatch",
  /\.eq\("user_id", userId\)/.test(chatRoute) &&
    /\.single\(\)/.test(chatRoute),
);
check(
  "route calls runAssistant with retrieveCvChunks seam",
  /runAssistant\([\s\S]*?retrieveCvChunks\(/.test(chatRoute),
);
check(
  "route passes retriever as `(uid, q) => retrieveCvChunks(...)`",
  /\(uid,\s*q\)\s*=>\s*retrieveCvChunks\(uid,\s*q\)/.test(chatRoute),
);
check(
  "route extracts citations only from general mode",
  /response\.mode === "general" \? response\.citations : null/.test(chatRoute),
);
check(
  "route persists citations into chat_messages.citations",
  /citations:\s*citations\s*&&\s*citations\.length\s*>\s*0\s*\?\s*citations\s*:\s*null/.test(
    chatRoute,
  ),
);
check(
  "route returns citations to the client",
  /citations:\s*citations\s*\?\?\s*\[\],/.test(chatRoute),
);

// ---------- 4. Upload route ----------

console.log("\n[4] Upload API route (app/api/cv/upload/route.ts)");
const uploadRoute = read("app/api/cv/upload/route.ts");

check(
  "upload route is `runtime = nodejs` (pdf-parse is CJS-only)",
  /export const runtime = "nodejs";/.test(uploadRoute),
);
check(
  "upload route rejects non-PDF/DOCX (extension check)",
  /ext !== "pdf" && ext !== "docx"/.test(uploadRoute) ||
    /unsupported file type/i.test(uploadRoute),
);
check(
  "upload route uploads to the `cvs` storage bucket",
  /\.storage[\s\S]{0,80}\.from\("cvs"\)/.test(uploadRoute),
);
check(
  "upload route creates a `cvs` row up-front with `ingest_status = 'processing'`",
  /ingest_status:\s*"processing"/.test(uploadRoute),
);
check(
  "upload route writes a default `name` from the filename",
  /name:\s*filename/.test(uploadRoute),
);
check(
  "upload route ingests via the `replace_cv_chunks` RPC",
  /replace_cv_chunks/.test(uploadRoute),
);
check(
  "upload route marks the row `ready` on success",
  /ingest_status:\s*"ready"/.test(uploadRoute),
);
check(
  "upload route `markFailed` writes a `failed` status with the error",
  /ingest_status:\s*"failed"/.test(uploadRoute) &&
    /error_message/.test(uploadRoute),
);

// ---------- 5. List endpoint ----------

console.log("\n[5] CV list endpoint (app/api/cv/list/route.ts)");
const cvList = read("app/api/cv/list/route.ts");

check(
  "list endpoint uses auth() / Clerk",
  /auth\(\)/.test(cvList),
);
check(
  "list endpoint returns 401 when unauthenticated",
  /401/.test(cvList) && /Unauthorized/.test(cvList),
);
check(
  "list endpoint filters by user_id",
  /\.eq\("user_id", userId\)/.test(cvList),
);
check(
  "list endpoint orders by created_at desc",
  /\.order\("created_at",\s*\{\s*ascending:\s*false\s*\}\)/.test(cvList),
);
check(
  "list endpoint returns the basic CV columns",
  /select\("id, name, status, created_at, is_active, version"\)/.test(cvList),
);

// ---------- 6. CRUD endpoint ----------

console.log("\n[6] CV CRUD endpoint (app/api/cv/[id]/route.ts)");
const cvCrud = read("app/api/cv/[id]/route.ts");

check(
  "CRUD route enforces user_id on every query",
  (cvCrud.match(/\.eq\("user_id", userId\)/g) || []).length >= 2,
);
check(
  "CRUD route deletes chunks before the row",
  (() => {
    const chunksIdx = cvCrud.search(/\.from\("cv_chunks"\)/);
    const rowIdx = cvCrud.search(/\.from\("cvs"\)\s*\.delete/);
    return chunksIdx > 0 && rowIdx > chunksIdx;
  })(),
  "expected cv_chunks delete to come before cvs row delete",
);
check(
  "CRUD route returns 404 when no row was deleted",
  /404/.test(cvCrud) && /not found/i.test(cvCrud),
);

// ---------- 7. Chunks inspector endpoint ----------

console.log("\n[7] CV chunks endpoint (app/api/cv/[id]/chunks/route.ts)");
const cvChunks = read("app/api/cv/[id]/chunks/route.ts");

check(
  "chunks endpoint enforces user_id on the chunks query",
  /\.eq\("user_id", userId\)/.test(cvChunks),
);
check(
  "chunks endpoint selects from cv_chunks",
  /\.from\("cv_chunks"\)/.test(cvChunks),
);
check(
  "chunks endpoint orders by ordinality (after section)",
  /\.order\("section"/.test(cvChunks) &&
    /\.order\("ordinality"/.test(cvChunks),
);

// ---------- 8. Name column migration ----------

console.log("\n[8] CV name column migration");
const mig = read("supabase/migrations/20260606_cv_name.sql");
check(
  "migration adds `name` text column idempotently",
  /add column if not exists name text/i.test(mig),
);
check(
  "migration creates a trgm index on name",
  /gin_trgm_ops/.test(mig) || /trgm/i.test(mig),
);

// ---------- 9. Status migration ----------

console.log("\n[9] CV status migration");
const migStatus = read("supabase/migrations/20260606_cv_ingest_status.sql");
check(
  "migration adds `status` text column idempotently",
  /add column if not exists status/i.test(migStatus),
);
check(
  "migration constrains status to the three known values",
  /'processing',\s*'ready',\s*'failed'/.test(migStatus),
);

// ---------- 10. CV page UI ----------

console.log("\n[10] CV page UI (app/(dashboard)/cv/page.tsx)");
const cvPage = read("app/(dashboard)/cv/page.tsx");
check(
  "CV page is a client component",
  /^"use client";/m.test(cvPage),
);
check(
  "CV page fetches /api/cv/list",
  /\/api\/cv\/list/.test(cvPage),
);
check(
  "CV page fetches /api/cv/[id]/chunks for the inspector",
  /\/api\/cv\/\$\{[^}]+\}\/chunks|\/api\/cv\/.{0,8}\/chunks/.test(cvPage),
);
check(
  "CV page posts to /api/cv/upload",
  /\/api\/cv\/upload/.test(cvPage),
);
check(
  "CV page uses DELETE for remove",
  /method:\s*"DELETE"/.test(cvPage),
);
check(
  "CV page renders status pills (ready/processing/failed)",
  /ready|processing|failed/i.test(cvPage),
);

// ---------- Summary ----------

console.log(
  `\n${"=".repeat(60)}\n${passed} passed, ${failed} failed${failed > 0 ? "" : " — pillar 2 wiring is sound"}\n`,
);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f.name}`);
  process.exit(1);
}
process.exit(0);
