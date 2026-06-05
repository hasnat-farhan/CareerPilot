/**
 * CV ingester.
 *
 * End-to-end pipeline for turning an uploaded file in Supabase
 * Storage into indexed chunks the RAG seam can search.
 *
 * Pipeline
 * --------
 *   1. Load the `cvs` row by `cvId`. The row carries the
 *      storage path in `file_url` (e.g. "user_2x.../uuid.pdf").
 *   2. Download the file from Storage via the service-role
 *      client (RLS bypasses; we already checked ownership in
 *      the upload route).
 *   3. Sniff the mime and run the parser. If `needsOcr`, mark
 *      the row as failed with a clear error and return — OCR
 *      is a future module.
 *   4. Chunk the parsed output. Each chunk carries its section,
 *      section label, content, and a placeholder `sourceImageUrl`
 *      (filled later when page images are rendered).
 *   5. Batch-embed all chunk contents with `embedBatch`
 *      (amortises the round-trip cost across chunks).
 *   6. Call `replace_cv_chunks` to atomically delete the old
 *      chunks for the (cv, all-sections) tuple and insert the
 *      new ones. We do a full-CV replace (not per-section)
 *      because the upload flow always re-indexes from scratch.
 *   7. Persist `raw_text`, `section_index`, and mark
 *      `status = 'ready'`. The retriever now finds the CV.
 *
 * Error handling
 * --------------
 * Every step is wrapped: if anything throws we mark the `cvs`
 * row with `status = 'failed'` and a human-readable
 * `error_message`, then re-throw so the caller (the upload
 * route's awaited `runIngestion` call) can surface a 500.
 *
 * Idempotency
 * -----------
 * Re-running on the same `cvId` is safe: `replace_cv_chunks`
 * deletes the old chunks before inserting, and the `cvs`
 * status update overwrites whatever was there. The
 * `section_index` is recomputed each time, so partial state
 * from a failed run is overwritten.
 *
 * Concurrency
 * -----------
 * We don't lock. If two uploads race, the last writer wins.
 * The partial unique index `cvs_one_active_per_user` still
 * guarantees at most one active CV per user; the other becomes
 * inactive. For v1 the upload API sets the new row inactive
 * until ingestion succeeds, then flips it active — so a failed
 * upload doesn't pollute the active set.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { embedBatch } from "@/lib/ai/provider";
import { parseCv, sniffMime, type ParserOutput } from "@/lib/cv/parser";
import { chunkCv, type CvChunk } from "@/lib/cv/chunker";

// ---------- Public types ----------

/** Lifecycle states for the `cvs.status` column. */
export type IngestionStatus = "processing" | "ready" | "failed";

export interface IngestionResult {
  /** Total chunks written to `cv_chunks`. */
  chunksWritten: number;
  /** Total tokens across all chunks (sum of `token_count`). */
  totalTokens: number;
  /** Wall-clock duration in milliseconds. Useful for logs. */
  durationMs: number;
  /** Sections that were detected and indexed. */
  sections: string[];
  /** True if the parser flagged the document for OCR. */
  needsOcr: boolean;
}

// ---------- DB row shape ----------

interface CvRow {
  id: string;
  user_id: string;
  file_url: string | null;
  source: "upload" | "builder";
  status: IngestionStatus;
  needs_ocr: boolean;
}

interface CvChunksRow {
  cv_id: string;
  user_id: string;
  section: string;
  section_label: string;
  content: string;
  embedding: string; // pgvector serialises as "[v1,v2,...]"
  ordinality: number;
  token_count: number;
  ocr_source: string | null;
  source_image_url: string | null;
  structured_payload: Record<string, unknown> | null;
  edited_at: string;
}

// ---------- Public entry points ----------

/**
 * Run the full ingestion pipeline for a single `cvId`. The
 * upload route awaits this directly; if we later add a real
 * job queue (Inngest, etc.) it can call this as a single
 * step and the contract is the same.
 */
export async function runIngestion(cvId: string): Promise<IngestionResult> {
  const t0 = Date.now();
  // 1. Mark as processing.
  await updateStatus(cvId, "processing", null);

  try {
    const cv = await loadCvRow(cvId);
    if (!cv.file_url) {
      throw new Error(`cv ${cvId} has no file_url (source=${cv.source})`);
    }

    // 2. Download the file from Storage.
    const buffer = await downloadFromStorage(cv.file_url);

    // 3. Parse.
    const parsed = await parseBuffer(buffer);

    // 4. OCR short-circuit. v1 surfaces a clear failure; later
    //    we'll plug in Tesseract / Gemini-Vision OCR and feed
    //    the result back into the chunker.
    if (parsed.needsOcr) {
      await updateStatus(
        cvId,
        "failed",
        "This PDF looks scanned (no extractable text). OCR is not yet enabled.",
      );
      return {
        chunksWritten: 0,
        totalTokens: 0,
        durationMs: Date.now() - t0,
        sections: [],
        needsOcr: true,
      };
    }

    // 5. Chunk.
    const chunks = chunkCv(
      parsed,
      { cvId, userId: cv.user_id },
      () => crypto.randomUUID(),
    );
    if (chunks.length === 0) {
      throw new Error("chunker produced zero chunks from non-empty parse");
    }

    // 6. Embed. Skip chunks with empty content (they exist so
    //    the chunk inspector can show "(empty)" rows). The
    //    DB column is NOT NULL, so empty-content chunks get
    //    a zero vector; the retriever naturally ignores them
    //    because the query's cosine distance to a zero vector
    //    depends only on its magnitude, and the user-facing
    //    query embedding is non-zero and uncorrelated with all-
    //    zeros, so empty chunks never outrank real content.
    const ZERO_VEC = new Array<number>(3072).fill(0);
    const embeddableIdx: number[] = [];
    const embeddableTexts: string[] = [];
    chunks.forEach((c, i) => {
      if (c.content.length > 0) {
        embeddableIdx.push(i);
        embeddableTexts.push(c.content);
      }
    });
    const vectors =
      embeddableTexts.length > 0
        ? await embedBatch(embeddableTexts, { taskType: "RETRIEVAL_DOCUMENT" })
        : [];
    if (vectors.length !== embeddableTexts.length) {
      throw new Error(
        `embedBatch length mismatch: expected ${embeddableTexts.length}, got ${vectors.length}`,
      );
    }
    // Build the per-chunk embedding map. embeddableIdx[k] is
    // the original chunk index; vectors[k] is its embedding.
    const enriched: CvChunksRow[] = chunks.map((c, i) => {
      const embeddablePos = embeddableIdx.indexOf(i);
      const vec = embeddablePos >= 0 ? vectors[embeddablePos]! : ZERO_VEC;
      return {
        cv_id: c.cvId,
        user_id: c.userId,
        section: c.section,
        section_label: c.sectionLabel,
        content: c.content,
        embedding: formatVector(vec),
        ordinality: c.ordinality,
        token_count: c.tokenCount,
        ocr_source: null,
        source_image_url: c.sourceImageUrl,
        structured_payload: c.structuredPayload,
        edited_at: new Date().toISOString(),
      };
    });

    // 7. Replace chunks atomically.
    const inserted = await replaceChunks(cvId, enriched);

    // 8. Persist raw_text + section_index + ready.
    await finalizeReady(cvId, parsed);

    return {
      chunksWritten: inserted,
      totalTokens: enriched.reduce((sum, c) => sum + c.token_count, 0),
      durationMs: Date.now() - t0,
      sections: Array.from(new Set(enriched.map((c) => c.section))),
      needsOcr: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateStatus(cvId, "failed", msg).catch(() => {
      // If even the failure-update fails, swallow — we're already
      // about to re-throw the original error.
    });
    throw err;
  }
}

// ---------- Pipeline steps ----------

async function loadCvRow(cvId: string): Promise<CvRow> {
  const { data, error } = await supabaseAdmin
    .from("cvs")
    .select("id, user_id, file_url, source, status, needs_ocr")
    .eq("id", cvId)
    .single();
  if (error) {
    throw new Error(`[ingester] loadCvRow(${cvId}) failed: ${error.message}`);
  }
  return data as CvRow;
}

async function downloadFromStorage(path: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage
    .from("cvs")
    .download(path);
  if (error) {
    throw new Error(`[ingester] storage download failed for ${path}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`[ingester] storage download returned null for ${path}`);
  }
  // `Blob#arrayBuffer` is available in Node 18+; Next 15 ships Node 20.
  const ab = await data.arrayBuffer();
  return Buffer.from(ab);
}

async function parseBuffer(buf: Buffer): Promise<ParserOutput> {
  // Reject unsupported mimes up front. parseCv's own sniff is
  // a fallback; we want a clear 4xx-shaped error here so the
  // upload route can return 415 rather than the generic 500
  // parseCv would throw.
  const mime = sniffMime(buf);
  if (!mime) {
    throw new Error("Unrecognised file type. Expected a PDF or DOCX.");
  }
  return parseCv(buf, { mime });
}

async function replaceChunks(cvId: string, chunks: CvChunksRow[]): Promise<number> {
  // The RPC expects a jsonb ARRAY of objects (one per chunk). We pass
  // the raw array — NOT `JSON.stringify(...)` — so that PostgREST
  // encodes it as a jsonb array on the wire. If you serialise to a
  // string first, PostgREST ships a text value that Postgres casts
  // to a SCALAR jsonb (the string itself), and the next
  // `jsonb_array_elements()` inside the RPC throws
  // "cannot extract elements from a scalar".
  const p_chunks = chunks.map((c) => ({
    section: c.section,
    section_label: c.section_label,
    content: c.content,
    // pgvector accepts a jsonb number-array and casts to vector.
    embedding: c.embedding,
    ordinality: c.ordinality,
    token_count: c.token_count,
    ocr_source: c.ocr_source,
    source_image_url: c.source_image_url,
    structured_payload: c.structured_payload,
    edited_at: c.edited_at,
  }));
  const sections = Array.from(new Set(chunks.map((c) => c.section)));

  const { data, error } = await supabaseAdmin.rpc("replace_cv_chunks", {
    p_cv_id: cvId,
    p_sections: sections,
    p_chunks,
  });
  if (error) {
    throw new Error(`[ingester] replace_cv_chunks failed: ${error.message}`);
  }
  return typeof data === "number" ? data : chunks.length;
}

async function finalizeReady(cvId: string, parsed: ParserOutput): Promise<void> {
  const sectionIndex = buildSectionIndex(parsed);
  const { error } = await supabaseAdmin
    .from("cvs")
    .update({
      raw_text: parsed.rawText,
      section_index: sectionIndex,
      status: "ready",
      error_message: null,
    })
    .eq("id", cvId);
  if (error) {
    throw new Error(`[ingester] finalizeReady(${cvId}) failed: ${error.message}`);
  }
}

async function updateStatus(
  cvId: string,
  status: IngestionStatus,
  errorMessage: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("cvs")
    .update({ status, error_message: errorMessage })
    .eq("id", cvId);
  if (error) {
    // Log only — the caller will surface the original error.
    console.error(`[ingester] updateStatus(${cvId}, ${status}) failed:`, error.message);
  }
}

// ---------- Helpers ----------

/**
 * Format a `number[]` embedding as the string pgvector
 * expects: "[v1,v2,...]". We send the jsonb-array form to the
 * RPC instead, but keeping this helper around for direct
 * inserts (e.g. the chunk inspector's "re-embed" button).
 */
export function formatVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

/**
 * Build a `{ section: [startLine, endLine] }` index from the
 * parser output. Lets a future "edit one section" UI re-derive
 * the section body from `raw_text` without re-parsing the file.
 */
function buildSectionIndex(parsed: ParserOutput): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const s of parsed.sections) {
    out[s.kind] = [s.startLine, s.endLine];
  }
  return out;
}
