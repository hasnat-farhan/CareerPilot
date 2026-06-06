/**
 * POST /api/cv/upload
 *
 * End-to-end CV ingestion pipeline for Pillar 2 (RAG).
 *
 *   1. Authenticate via Clerk (`auth()`).
 *   2. Read the uploaded file from the form-data (`FormData`).
 *   3. Push the raw bytes to Supabase Storage at
 *        `${userId}/${Date.now()}_${filename}`
 *      in the private `cvs` bucket.
 *   4. Parse to plain text via `parseCv` (PDF → `unpdf`, DOCX → `mammoth`).
 *   5. Insert a `cvs` row with `ingest_status = 'processing'` and the
 *      freshly-stored file path. Ownership (user_id) is enforced
 *      server-side here; RLS is bypassed because the admin client
 *      runs with the service-role key.
 *   6. Split the text into section chunks via `chunkCv`.
 *   7. Embed each chunk with `embedBatch` (Gemini 3072-dim vectors).
 *   8. Persist via the `replace_cv_chunks(p_cv_id, p_sections, p_chunks)`
 *      RPC. The RPC's per-chunk jsonb shape is documented in
 *      `supabase/migrations/20260605_cv.sql`; the columns not in the
 *      spec (`section_label`, `ordinality`, `token_count`, `edited_at`)
 *      are derived here so the INSERT doesn't fail on NOT-NULL columns.
 *   9. Flip the row to `ingest_status = 'ready'` and store
 *      `raw_text` + a section index.
 *  10. Respond `{ cv_id, chunks }`.
 *
 * If anything throws after the row is created, we mark it `'failed'`
 * with the error message and re-throw so Next surfaces a 500 to the
 * client.
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseCv } from "@/lib/cv/parse";
import { chunkCv } from "@/lib/cv/chunk";
import { embedBatch } from "@/lib/ai/embeddings";

// Next.js App Router: serve large uploads and force the dynamic
// (non-static) path. 20 MB matches the bucket's `file_size_limit`.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Pro plan cap; 26s would be too tight for embed.

interface RpcChunkPayload {
  section: string;
  section_label: string;
  content: string;
  embedding: string; // stringified number[] for the jsonb → vector(3072) cast
  ordinality: number;
  token_count: number;
  edited_at: string; // ISO timestamp
}

export async function POST(request: Request) {
  // (1) Auth ────────────────────────────────────────────────────────
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // (2) Form data ───────────────────────────────────────────────────
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

  // (3) Upload raw file to Supabase Storage ────────────────────────
  const storagePath = `${userId}/${Date.now()}_${filename}`;
  const { error: storageError } = await supabaseAdmin.storage
    .from("cvs")
    .upload(storagePath, buffer, {
      contentType:
        ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      upsert: false,
    });

  if (storageError) {
    return NextResponse.json(
      { error: `Storage upload failed: ${storageError.message}` },
      { status: 500 },
    );
  }

  // (5) Create the cvs row up-front so the RPC has a target ───────
  // We use a closure so that any later step can mark the row
  // 'failed' without re-doing the storage upload.
  const { data: cvRow, error: cvInsertError } = await supabaseAdmin
    .from("cvs")
    .insert({
      user_id: userId,
      file_url: storagePath,
      name: filename,
      ingest_status: "processing",
      is_active: false, // will flip to true only when ingest succeeds
    })
    .select("id")
    .single();

  if (cvInsertError || !cvRow) {
    return NextResponse.json(
      { error: `Failed to create cv row: ${cvInsertError?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  const cvId = cvRow.id as string;

  const markFailed = async (message: string): Promise<NextResponse> => {
    await supabaseAdmin
      .from("cvs")
      .update({ ingest_status: "failed", error_message: message })
      .eq("id", cvId);
    return NextResponse.json(
      { error: message, cv_id: cvId },
      { status: 500 },
    );
  };

  try {
    // (4) Parse to text ────────────────────────────────────────────
    const rawText = await parseCv(buffer, filename);

    if (!rawText || rawText.trim().length === 0) {
      return await markFailed("Parser returned empty text");
    }

    // (6) Chunk by section ────────────────────────────────────────
    const chunks = chunkCv(rawText);
    if (chunks.length === 0) {
      return await markFailed("Chunker produced no chunks (file may be unscannable text)");
    }

    // (7) Embed all chunks in one batched Gemini call ─────────────
    // The section header is prepended so the embedding reflects
    // both the section's topic and the content.
    const inputs = chunks.map(
      (c) => `${c.section}\n${c.text}`,
    );
    const vectors = await embedBatch(inputs);
    if (vectors.length !== chunks.length) {
      return await markFailed(
        `Embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
      );
    }

    // (8) Persist via replace_cv_chunks RPC ───────────────────────
    // The RPC's per-element jsonb shape (per migration 20260605_cv.sql):
    //   { section, section_label, content, embedding (text),
    //     ordinality, token_count, ocr_source?, source_image_url?,
    //     structured_payload?, edited_at? }
    // `cv_id` and `user_id` are NOT in the jsonb — the RPC reads
    // `user_id` from the cvs row and uses `p_cv_id` for the FK.
    const sections = Array.from(new Set(chunks.map((c) => c.section)));
    const nowIso = new Date().toISOString();

    const rpcPayload: RpcChunkPayload[] = chunks.map((c, i) => {
      const vector = vectors[i];
      if (!vector) {
        throw new Error(`Missing embedding vector for chunk ${i}`);
      }
      return {
        section: c.section,
        section_label: c.section,
        content: c.text,
        // Cast to a Postgres-friendly text representation; the
        // RPC's `(elem->>'embedding')::vector(3072)` parses it back
        // into a float8[] for pgvector.
        embedding: `[${vector.join(",")}]`,
        ordinality: i,
        token_count: c.text.split(/\s+/).filter(Boolean).length,
        edited_at: nowIso,
      };
    });

    const { error: rpcError } = await supabaseAdmin.rpc(
      "replace_cv_chunks",
      {
        p_cv_id: cvId,
        p_sections: sections,
        p_chunks: rpcPayload,
      },
    );

    if (rpcError) {
      return await markFailed(`replace_cv_chunks RPC failed: ${rpcError.message}`);
    }

    // (9) Mark ready, persist raw text + a section index ──────────
    const { error: updateError } = await supabaseAdmin
      .from("cvs")
      .update({
        ingest_status: "ready",
        is_active: true,
        raw_text: rawText,
        section_index: sections,
        error_message: null,
      })
      .eq("id", cvId);

    if (updateError) {
      return await markFailed(`Failed to mark cv ready: ${updateError.message}`);
    }

    // (10) Success ────────────────────────────────────────────────
    return NextResponse.json({ cv_id: cvId, chunks: chunks.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown ingest error";
    return await markFailed(message);
  }
}
