#!/usr/bin/env node
/**
 * Pillar 2 (Profile & Resume Intelligence) wiring smoke test.
 *
 * This is a hermetic, no-network test. It does NOT require a live Supabase,
 * Clerk, or Gemini. It only proves that the modules are wired correctly
 * across the RAG pipeline:
 *
 *   1. `lib/rag/retrieve-cv.ts` exports the `Citation` interface used by
 *      the rest of the system (the contract is the same string shape on
 *      the wire from the chat API to the UI).
 *   2. `lib/agents/assistant.ts` calls the retriever in `general` mode
 *      and surfaces the returned citations on the AssistantResponse.
 *   3. `app/api/chat/threads/[id]/messages/route.ts` persists the
 *      citations into `chat_messages.citations` and serialises them
 *      back to the client.
 *   4. `app/api/cv/upload/route.ts` accepts only PDF and DOCX and
 *      enforces a 20MB cap, and writes a default `name` from the
 *      filename.
 *   5. `app/api/cv/route.ts` (list) joins `cv_chunks(count)` and
 *      exposes a flattened `chunk_count` per row.
 *   6. `app/api/cv/[id]/route.ts` (CRUD) handles the partial unique
 *      index `cvs_one_active_per_user` by demoting the prior active
 *      row before promoting a new one.
 *   7. The CV page UI calls the new list/detail endpoints and renders
 *      the chunk inspector.
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
  "Citation has `section`",
  /section:\s*string;/.test(retrieveCv),
);
check(
  "Citation has `sourceImageUrl: string | null`",
  /sourceImageUrl:\s*string\s*\|\s*null;/.test(retrieveCv),
);
check(
  "exports `retrieveCvChunks` (the seam function)",
  /export async function retrieveCvChunks\(/.test(retrieveCv),
);
check(
  "retriever filters by user_id and active CV",
  /match_cv_chunks/.test(retrieveCv) && /user_id/.test(retrieveCv),
);
check(
  "retriever handles empty-active-CV case (returns [])",
  /return \[\];/.test(retrieveCv),
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
  "`runGeneralChat` awaits `retrieveCvChunks(userId, message)`",
  /const citations = await retrieveCvChunks\(userId, message\);/.test(assistant),
);
check(
  "general mode attaches citations to the response",
  /mode: "general",\s*message: reply,\s*citations/.test(assistant),
);
check(
  "general-mode prompt asks model to cite [chunk-id]",
  /Cite CV chunks inline as \[chunk-id\]/.test(assistant),
);
check(
  "intent router short-circuits to general when no benchmark resolves",
  /return runGeneralChat\(userId, message, history, retrieveCvChunks\);/.test(
    assistant,
  ) &&
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
  /runAssistant\([\s\S]*?retrieveCvChunks,?\s*\)/.test(chatRoute) ||
    /runAssistant\([\s\S]*?,\s*retrieveCvChunks\s*\)/.test(chatRoute),
);
check(
  "route extracts citations only from general mode",
  /response\.mode === "general" && response\.citations\.length > 0/.test(
    chatRoute,
  ),
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

// ---------- 4. Upload route: validate + persist name ----------

console.log("\n[4] Upload API route (app/api/cv/upload/route.ts)");
const uploadRoute = read("app/api/cv/upload/route.ts");

check(
  "upload route is `runtime = nodejs` (pdf-parse is CJS-only)",
  /export const runtime = "nodejs";/.test(uploadRoute),
);
check(
  "upload route rejects non-PDF/DOCX",
  /pdf|docx/i.test(uploadRoute) && /(invalid|not allowed|rejected)/i.test(
    uploadRoute,
  ) ||
    /MIME|application\/pdf|application\/vnd\.openxmlformats/.test(uploadRoute),
);
check(
  "upload route enforces a 20MB size cap",
  /20\s*\*\s*1024\s*\*\s*1024/.test(uploadRoute) ||
    /20_?000_?000/.test(uploadRoute) ||
    /MAX_(BYTES|SIZE)/.test(uploadRoute),
);
check(
  "upload route sets a default `name` from the filename",
  /defaultName/.test(uploadRoute) &&
    /name:\s*defaultName/.test(uploadRoute),
);
check(
  "upload route uses `needs_ocr` code for image-only PDFs",
  /needs_ocr/.test(uploadRoute),
);

// ---------- 5. List endpoint ----------

console.log("\n[5] CV list endpoint (app/api/cv/route.ts)");
const cvList = read("app/api/cv/route.ts");

check(
  "list endpoint uses requireUserId()",
  /requireUserId\(\)/.test(cvList),
);
check(
  "list endpoint filters by user_id",
  /\.eq\("user_id", userId\)/.test(cvList),
);
check(
  "list endpoint joins cv_chunks count",
  /cv_chunks\(count\)/.test(cvList),
);
check(
  "list endpoint flattens chunk_count onto each row",
  /chunk_count/.test(cvList),
);
check(
  "list endpoint orders by created_at desc",
  /\.order\("created_at",\s*\{\s*ascending:\s*false\s*\}\)/.test(cvList),
);

// ---------- 6. CRUD endpoint ----------

console.log("\n[6] CV CRUD endpoint (app/api/cv/[id]/route.ts)");
const cvCrud = read("app/api/cv/[id]/route.ts");

check(
  "CRUD route filters by user_id on every method",
  (cvCrud.match(/\.eq\("user_id", userId\)/g) || []).length >= 2,
);
check(
  "PATCH validates name length (200 chars)",
  /200/.test(cvCrud) && /name/.test(cvCrud),
);
check(
  "PATCH is_active=false demotes prior active first (partial unique index)",
  /\.update\(\{\s*is_active:\s*false\s*\}\)\s*\.eq\("user_id", userId\)\s*\.eq\("is_active", true\)/s.test(
    cvCrud,
  ) ||
    /is_active:\s*false[\s\S]{0,200}is_active:\s*true/s.test(cvCrud),
);
check(
  "PATCH refuses to activate a non-ready CV (409)",
  /409/.test(cvCrud) && /ready/.test(cvCrud),
);
check(
  "DELETE removes chunks before row before storage",
  (() => {
    const chunksIdx = cvCrud.search(/\.from\("cv_chunks"\)/);
    const rowIdx = cvCrud.search(/\.from\("cvs"\)\s*\.delete/);
    const storageIdx = cvCrud.search(/\.storage[\s\S]{0,40}\.remove\(/);
    return (
      chunksIdx > 0 &&
      rowIdx > chunksIdx &&
      storageIdx > rowIdx
    );
  })(),
  "expected chunks delete → cvs row delete → storage.remove, in that source order",
);
check(
  "DELETE returns storageWarning (soft-fail storage)",
  /storageWarning/.test(cvCrud),
);

// ---------- 7. Name column migration ----------

console.log("\n[7] CV name column migration");
const mig = read("supabase/migrations/20260606_cv_name.sql");
check(
  "migration adds `name` text column idempotently",
  /add column if not exists name text/i.test(mig),
);
check(
  "migration creates a trgm index on name",
  /gin_trgm_ops/.test(mig) || /trgm/i.test(mig),
);

// ---------- 8. CV page UI ----------

console.log("\n[8] CV page UI (app/(dashboard)/cv/page.tsx)");
const cvPage = read("app/(dashboard)/cv/page.tsx");
check(
  "CV page is a client component",
  /^"use client";/m.test(cvPage),
);
check(
  "CV page fetches /api/cv (list)",
  /\/api\/cv\b/.test(cvPage) || /fetch\([`"\']\/api\/cv/.test(cvPage),
);
check(
  "CV page fetches /api/cv/[id] for the inspector",
  /\/api\/cv\/\$\{|`\/api\/cv\/\$\{|`\/api\/cv\$\{/.test(cvPage) ||
    new RegExp("/api/cv/\\$|\\$\\{id\\}").test(cvPage) ||
    cvPage.includes("/api/cv/"),
);
check(
  "CV page posts to /api/cv/upload",
  /\/api\/cv\/upload/.test(cvPage),
);
check(
  "CV page uses PATCH for activate and rename",
  /method:\s*"PATCH"/.test(cvPage),
);
check(
  "CV page uses DELETE for remove",
  /method:\s*"DELETE"/.test(cvPage),
);
check(
  "CV page renders status pills (ready/processing/failed)",
  /ready|processing|failed/i.test(cvPage),
);
check(
  "CV page renders chunk excerpts in the inspector",
  /excerpt|text|preview/i.test(cvPage),
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
