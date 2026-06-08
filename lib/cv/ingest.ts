/**
 * Shared CV ingest pipeline.
 *
 * Factored out of `app/api/cv/upload/route.ts` so that the background
 * warmup route (`app/api/cv/warmup/route.ts`) can run the same code
 * path against `public/warmup.pdf`. This pays the cold-start cost
 * (PDF parse + Gemini embed batch) once on first sign-in, so the
 * user's first *real* upload feels warm.
 *
 * Two callers, one pipeline. The shape is intentionally minimal:
 *
 *   ingestCv({ userId, fileName, buffer, isWarmup })
 *     -> { cvId, chunkCount, storagePath }
 *     -> throws on failure; the row is left as `status = "failed"`
 *        with an `error_message` for diagnostics.
 *
 * Caller responsibilities:
 *   - Authentication / authorization of the `userId`.
 *   - Authorization of the upload (file size, mime type, quota).
 *   - Deciding what to do with the row afterwards (the upload
 *     route returns the cv_id; the warmup route deletes it).
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseCv } from "@/lib/cv/parse";
import { chunkCv } from "@/lib/cv/chunk";
import { embedBatch } from "@/lib/ai/embeddings";

/**
 * Per-element jsonb shape expected by the `replace_cv_chunks` RPC
 * (see `supabase/migrations/20260605_cv.sql`). The columns `id`,
 * `user_id`, `embedding` (as a real vector), and `created_at` are
 * filled in by the RPC itself; everything else we pass through.
 */
interface RpcChunkPayload {
  section: string;
  section_label: string;
  content: string;
  /** Stringified `number[]`; the RPC casts to `vector(3072)`. */
  embedding: string;
  ordinality: number;
  token_count: number;
  edited_at: string;
}

export interface IngestOptions {
  /** Authenticated Clerk user id (or eval header). */
  userId: string;
  /** Filename as it should appear on the `cvs.name` column. */
  fileName: string;
  /** Raw file bytes. */
  buffer: Buffer;
  /**
   * True for the warmup run. Lets us:
   *   - Tag the row so the list route can filter it out of the
   *     default view (the warmup is invisible to the user).
   *   - Soften error messages: a warmup failure must not look
   *     like a real upload failure in logs.
   */
  isWarmup?: boolean;
}

export interface IngestResult {
  cvId: string;
  chunkCount: number;
  storagePath: string;
}

/**
 * Run the full ingest pipeline. On success the row is `status = "ready"`
 * and the chunks are persisted. On failure the row is `status = "failed"`
 * with `error_message` set, and the error is re-thrown.
 *
 * Errors thrown by the route caller should be treated as user-facing
 * (the row's error_message mirrors them); the warmup route suppresses
 * non-fatal errors at its own layer.
 */
export async function ingestCv(opts: IngestOptions): Promise<IngestResult> {
  const { userId, fileName, buffer, isWarmup = false } = opts;
  const ext = fileName.split(".").pop()?.toLowerCase();

  // (3) Storage upload. Path is `${userId}/${ts}_${fileName}` so the
  // bucket layout matches the upload route exactly. We do this BEFORE
  // inserting the row so a storage failure doesn't leave an orphan
  // `cvs` row pointing at nothing.
  const storagePath = `${userId}/${Date.now()}_${fileName}`;
  const { error: storageError } = await supabaseAdmin.storage
    .from("cvs")
    .upload(storagePath, buffer, {
      contentType:
        ext === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      upsert: false,
    });

  if (storageError) {
    throw new Error(`Storage upload failed: ${storageError.message}`);
  }

  // (5) Insert the row up front. The warmup flag is encoded in the
  // `name` so the list route can filter it cheaply with a single
  // string-prefix check on the `name` column. We do NOT add a column
  // for this; the row is deleted by the warmup route on success and
  // stays in `processing`/`failed` if something goes wrong (so a
  // debugging user can see what happened in the UI; the list route
  // hides it from the public view).
  const { data: cvRow, error: cvInsertError } = await supabaseAdmin
    .from("cvs")
    .insert({
      user_id: userId,
      file_url: storagePath,
      name: fileName,
      status: "processing",
      is_active: false,
    })
    .select("id")
    .single();

  if (cvInsertError || !cvRow) {
    // Best-effort cleanup of the storage object so we don't leak bytes.
    await supabaseAdmin.storage.from("cvs").remove([storagePath]);
    throw new Error(
      `Failed to create cv row: ${cvInsertError?.message ?? "unknown"}`,
    );
  }

  const cvId = cvRow.id as string;

  // Closure: any failure path after the insert must leave the row in
  // a diagnosable state. We re-throw so the caller can decide whether
  // to surface the error to the user.
  const markFailed = async (message: string): Promise<never> => {
    await supabaseAdmin
      .from("cvs")
      .update({ status: "failed", error_message: message })
      .eq("id", cvId);
    throw new Error(message);
  };

  try {
    // (4) Parse
    const rawText = await parseCv(buffer, fileName);
    if (!rawText || !rawText.trim()) {
      return await markFailed("Parser returned empty text");
    }

    // (6) Chunk
    const chunks = chunkCv(rawText);
    if (chunks.length === 0) {
      return await markFailed(
        "Chunker produced no chunks (file may be unscannable text)",
      );
    }

    // (7) Embed (one batched Gemini call; same as the original route)
    const inputs = chunks.map(
      (c) => `${c.section_label}\n${c.content}`,
    );
    let vectors: number[][];
    try {
      vectors = await embedBatch(inputs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Translate the cryptic SDK 401 into a hint. Same hint as the
      // original upload route; kept verbatim so the user sees the
      // same guidance whether they hit it via upload or warmup.
      if (
        /401|ACCESS_TOKEN_TYPE_UNSUPPORTED|invalid authentication credentials/i.test(
          message,
        )
      ) {
        return await markFailed(
          `Gemini rejected the API key (401). Check GEMINI_API_KEY in .env.local — ` +
            `it must be a Google AI Studio key starting with "AIzaSy". ` +
            `Get one at https://aistudio.google.com/apikey. ` +
            `You can also try a different embedding model via GEMINI_EMBED_MODEL ` +
            `(matching dim via GEMINI_EMBEDDING_DIM). ` +
            `Original error: ${message}`,
        );
      }
      throw err;
    }
    if (vectors.length !== chunks.length) {
      return await markFailed(
        `Embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
      );
    }

    // (8) Persist chunks via the `replace_cv_chunks` RPC.
    const sections = Array.from(new Set(chunks.map((c) => c.section)));
    const nowIso = new Date().toISOString();

    const rpcPayload: RpcChunkPayload[] = chunks.map((c, i) => {
      const vector = vectors[i];
      if (!vector) {
        throw new Error(`Missing embedding vector for chunk ${i}`);
      }
      return {
        section: c.section,
        section_label: c.section_label,
        content: c.content,
        embedding: `[${vector.join(",")}]`,
        ordinality: c.ordinality,
        token_count: c.token_count,
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

    // (9) Mark ready. For warmups we intentionally keep `is_active = false`
    // (warmups are never user-visible); the upload route keeps the same
    // contract and lets the user promote via PATCH.
    const { error: updateError } = await supabaseAdmin
      .from("cvs")
      .update({
        status: "ready",
        is_active: false,
        raw_text: rawText,
        section_index: sections,
        error_message: null,
      })
      .eq("id", cvId);

    if (updateError) {
      return await markFailed(`Failed to mark cv ready: ${updateError.message}`);
    }

    return { cvId, chunkCount: chunks.length, storagePath };
  } catch (err) {
    // If `markFailed` already threw with a sanitized message, re-throw
    // as-is. Otherwise wrap the raw error so the row is annotated.
    const message = err instanceof Error ? err.message : "Unknown ingest error";
    try {
      await supabaseAdmin
        .from("cvs")
        .update({ status: "failed", error_message: message })
        .eq("id", cvId);
    } catch {
      // Swallow: the original error is more useful to the caller.
    }
    if (isWarmup) {
      // Warmup errors are not actionable for the user. Log the
      // failure and re-throw a tagged error so the warmup route
      // can decide whether to surface it.
      // eslint-disable-next-line no-console
      console.warn(`[ingest] warmup failed for ${userId}: ${message}`);
    }
    throw err;
  }
}

/**
 * Delete a CV row and its chunks. Mirrors the public DELETE handler
 * in `app/api/cv/[id]/route.ts` so the warmup route can clean up
 * without re-implementing the ownership check.
 *
 * Chunks are deleted first (the FK has `on delete cascade`, but we
 * keep the explicit delete so the row count is observable in the
 * response and the call is robust if the cascade is ever removed).
 */
export async function deleteCv(cvId: string, userId: string): Promise<{ chunksDeleted: number }> {
  const { error: chunksError, count: chunksDeleted } = await supabaseAdmin
    .from("cv_chunks")
    .delete({ count: "exact" })
    .eq("cv_id", cvId)
    .eq("user_id", userId);

  if (chunksError) {
    throw new Error(`Failed to delete chunks: ${chunksError.message}`);
  }

  const { error: cvError } = await supabaseAdmin
    .from("cvs")
    .delete({ count: "exact" })
    .eq("id", cvId)
    .eq("user_id", userId);

  if (cvError) {
    throw new Error(`Failed to delete CV: ${cvError.message}`);
  }

  return { chunksDeleted: chunksDeleted ?? 0 };
}

/**
 * The `name` prefix used to mark warmup rows. Keeping it centralised
 * here so the list route and the warmup route can't drift.
 */
export const WARMUP_NAME_PREFIX = "__warmup__";
