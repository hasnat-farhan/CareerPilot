/**
 * POST /api/cv/upload
 *
 * Public entry point for Pillar 2 (RAG) CV ingestion. The full
 * parse → chunk → embed → RPC → update pipeline lives in
 * `lib/cv/ingest.ts` so the internal `_warmup` route can run the
 * exact same code path on a placeholder PDF.
 *
 *   1. Authenticate (Clerk in prod, `x-eval-user-id` in eval mode).
 *   2. Parse the multipart form-data and validate the file type.
 *   3. Hand the buffer to `ingestCv({ userId, fileName, buffer })`.
 *   4. Surface the result as `{ cv_id, chunks }`.
 *
 * The 401 translation hint, `markFailed` writes, and the
 * `cvs` row → `replace_cv_chunks` round-trip are all encapsulated
 * inside `ingestCv`. If it throws, the row is already marked
 * `'failed'` with the error message before the throw, so the
 * client only sees the surfaced 500.
 *
 * Next.js App Router config: long maxDuration (matches the warmup
 * route), force-dynamic (auth-dependent), Node runtime (no Edge).
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { ingestCv } from "@/lib/cv/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Pro; Hobby's 10s ceiling is the very problem this route + warmup are solving.

export async function POST(request: Request) {
  // (1) Auth ────────────────────────────────────────────────────
  // In production we use Clerk's `auth()`. In eval/dev-eval mode
  // (EVAL_BYPASS_AUTH=1), we read the user id from the
  // `x-eval-user-id` header instead. This unlocks end-to-end
  // testing from the eval runner or a curl-based smoke script.
  // When EVAL_BYPASS_AUTH is unset, the header is ignored.
  let userId: string | null = null;
  if (process.env.EVAL_BYPASS_AUTH === "1") {
    const h = await headers();
    userId = h.get("x-eval-user-id")?.trim() ?? null;
    if (!userId) {
      return NextResponse.json(
        { error: "EVAL_BYPASS_AUTH=1 but x-eval-user-id header missing" },
        { status: 500 },
      );
    }
  } else {
    const authResult = await auth();
    userId = authResult.userId;
  }
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // (2) Form data ──────────────────────────────────────────────
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing or invalid 'file' field" },
      { status: 400 },
    );
  }

  const filename = file.name || "cv.pdf";
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext !== "pdf" && ext !== "docx") {
    return NextResponse.json(
      { error: `Unsupported file type: ${ext ?? "(none)"}` },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }

  // (3) Delegate the heavy lifting ─────────────────────────────
  // `ingestCv` will: upload the file to storage, insert the cvs
  // row, parse, chunk, embed, call replace_cv_chunks, and flip
  // status to "ready". On any failure it marks the row "failed"
  // with the message and re-throws — we just surface a 500.
  try {
    const result = await ingestCv({
      userId,
      fileName: filename,
      buffer,
    });
    return NextResponse.json({ cv_id: result.cvId, chunks: result.chunkCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown ingest error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
