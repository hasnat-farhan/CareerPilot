/**
 * POST /api/cv/upload
 *
 * Upload a CV file (PDF or DOCX), persist it to Supabase
 * Storage, and run the ingester synchronously to chunk +
 * embed it. The new CV becomes the active one on success;
 * a failed upload leaves the previous active CV untouched.
 *
 * Body: multipart/form-data with a `file` field. Optional
 *       `setActive: "true" | "false"` (default true).
 *
 * Response (200):
 *   { cv: CvSummary, result: IngestionResult }
 *
 * Response (4xx):
 *   { error: string, code: "no_file" | "bad_mime" | "too_big" | "ingest_failed" }
 *
 * Auth: Clerk (requireUserId).
 * Runtime: nodejs — the parser uses Buffer and pdf-parse needs
 *          Node, not the Edge runtime.
 */

import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { runIngestion, type IngestionResult } from "@/lib/cv/ingester";
import { sniffMime } from "@/lib/cv/parser";

export const runtime = "nodejs";
// 20 MB. The bucket cap matches; we enforce here so we can
// return a clean 413 instead of a stream-truncated error.
export const maxDuration = 60; // seconds; covers parser + embedder

// ---------- Limits ----------

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

// ---------- Types ----------

interface CvSummary {
  id: string;
  status: string;
  is_active: boolean;
  version: number;
}

// ---------- Route ----------

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  // 1. Parse multipart.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data.", code: "bad_form" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing 'file' field.", code: "no_file" },
      { status: 400 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json(
      { error: "Uploaded file is empty.", code: "empty_file" },
      { status: 400 },
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; max is 20 MB.`,
        code: "too_big",
      },
      { status: 413 },
    );
  }

  // 2. Validate mime. The browser's content-type is NOT
  //    trustworthy; we sniff the bytes.
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffMime(buf);
  if (!mime || !ALLOWED_MIMES.has(mime)) {
    return NextResponse.json(
      { error: "Only PDF and DOCX files are supported.", code: "bad_mime" },
      { status: 415 },
    );
  }
  const ext = EXT_BY_MIME[mime] ?? "bin";

  // 3. Compute storage path. Per-user folder keeps the bucket
  //    tidy and lets us list a user's files cheaply.
  //    The CV id is generated up front so we can upload before
  //    we insert the row (avoids a race where the upload
  //    succeeds but the insert fails, leaving an orphan).
  const cvId = crypto.randomUUID();
  const storagePath = `${userId}/${cvId}.${ext}`;

  // 4. Upload to storage.
  const { error: uploadErr } = await supabaseAdmin.storage
    .from("cvs")
    .upload(storagePath, buf, {
      contentType: mime,
      cacheControl: "3600",
      upsert: false,
    });
  if (uploadErr) {
    return NextResponse.json(
      { error: `Storage upload failed: ${uploadErr.message}`, code: "storage_failed" },
      { status: 500 },
    );
  }

  // 5. Insert the cvs row in `processing` state and NOT
  //    active. We flip active=true at the end on success;
  //    a failed upload leaves the previous active CV intact.
  //    The partial unique index `cvs_one_active_per_user`
  //    means at most one active row per user — a new
  //    inactive row is fine.
  // Strip the extension from the original filename so the list view
  // shows "John_Doe_Resume" instead of "John_Doe_Resume.pdf".
  const defaultName = file.name.replace(/\.[^./]+$/, "").slice(0, 200) || null;

  const { data: cvRow, error: insertErr } = await supabaseAdmin
    .from("cvs")
    .insert({
      id: cvId,
      user_id: userId,
      file_url: storagePath,
      source: "upload",
      status: "processing",
      is_active: false,
      name: defaultName,
    })
    .select("id, status, is_active, version, name")
    .single();
  if (insertErr || !cvRow) {
    // Roll back the storage upload so we don't leak orphan files.
    await supabaseAdmin.storage.from("cvs").remove([storagePath]);
    return NextResponse.json(
      { error: `DB insert failed: ${insertErr?.message ?? "unknown"}`, code: "db_failed" },
      { status: 500 },
    );
  }

  // 6. Run the ingester. This is the slow step (parse +
  //    chunk + embed). For a typical CV it's a few seconds.
  let result: IngestionResult;
  try {
    result = await runIngestion(cvId);
  } catch (err) {
    // The ingester already wrote status='failed' and
    // error_message to the row. Don't touch the previous
    // active CV.
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, code: "ingest_failed" },
      { status: 500 },
    );
  }

  // 7. If the parse flagged OCR, surface a 422 — the file
  //    is "kept" (in failed state) but not indexed.
  if (result.needsOcr) {
    return NextResponse.json(
      {
        error:
          "This PDF looks scanned. We saved it, but OCR isn't enabled yet — check back soon.",
        code: "needs_ocr",
        cv: cvRow as CvSummary,
      },
      { status: 422 },
    );
  }

  // 8. Flip the new CV to active. The partial unique index
  //    guarantees at most one active row per user, so we
  //    first mark the previous active (if any) inactive.
  const setActive = (form.get("setActive") ?? "true") === "true";
  if (setActive) {
    await supabaseAdmin
      .from("cvs")
      .update({ is_active: false })
      .eq("user_id", userId)
      .eq("is_active", true)
      .neq("id", cvId);
    await supabaseAdmin
      .from("cvs")
      .update({ is_active: true })
      .eq("id", cvId);
  }

  // 9. Re-read the row so the response reflects the final state.
  const { data: finalRow } = await supabaseAdmin
    .from("cvs")
    .select("id, status, is_active, version")
    .eq("id", cvId)
    .single();

  return NextResponse.json(
    { cv: finalRow ?? cvRow, result },
    { status: 200 },
  );
}
