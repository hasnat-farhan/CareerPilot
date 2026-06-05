/**
 * RAG retrieval seam.
 *
 * The chat route calls this on every turn to fetch relevant chunks from
 * the user's active CV before composing the prompt. The hunter and
 * fit-score agents call it the same way. The single `Citation` shape
 * returned here is the contract that the API route serialises to the
 * client, so keep it stable.
 *
 * Pipeline:
 *   1. Embed the query with `gemini-embedding-2` (3072-dim) using the
 *      RETRIEVAL_QUERY task hint.
 *   2. Call the `match_cv_chunks` SQL function (see
 *      `supabase/migrations/20260605_cv.sql`) - brute-force cosine scan
 *      filtered by `user_id` and the user's single active CV row. We
 *      don't index the vector column on Supabase (pgvector <0.5.0 caps
 *      both ivfflat and hnsw at 2000-dim; our embeddings are 3072-dim)
 *      and that's fine because per-user chunk counts are in the tens.
 *   3. Map the RPC row shape to the `Citation` shape used by the agents
 *      and the chat UI.
 *
 * Failure modes:
 *   - No active CV yet (uploads pending, first sign-in, etc.) - the
 *     RPC returns zero rows, we return []. Agents tolerate this.
 *   - Embedding call fails (rate limit, key missing, etc.) - we
 *     re-throw. The chat route catches it and falls back to general
 *     chat. The fit-score / hunter agents let it bubble.
 *   - RPC call fails (network, RLS tripped, etc.) - we re-throw with
 *     context. Same downstream contract.
 */

import { embedText } from "@/lib/ai/provider";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Stable identifier for the chunk (matches `cv_chunks.id` in Supabase). */
export interface Citation {
  /** UUID from `cv_chunks.id`. Stable across the lifetime of the chunk. */
  id: string;
  /**
   * Human-readable label, e.g. "CV > Experience > Acme Corp (2024)".
   * Built by the parser/chunker; surfaced as the citation body in the
   * chat UI and the assistant's `[chunk-id]` references.
   */
  source: string;
  /** Chunk text verbatim - rendered as the citation body in the UI. */
  text: string;
  /**
   * Cosine similarity to the query, in [0, 1]. Higher is closer.
   * Computed server-side as `1 - (embedding <=> query)`.
   */
  score: number;
  /** Section type from the chunk's `section` column. */
  section: string;
  /**
   * Storage path of the page image this chunk was derived from, if any.
   * The chat UI uses this to render a "view source page" link.
   */
  sourceImageUrl: string | null;
}

/** Row shape returned by the `match_cv_chunks` RPC. */
interface MatchRow {
  id: string;
  section: string;
  section_label: string;
  content: string;
  source_image_url: string | null;
  similarity: number;
}

/**
 * Embed the user's question and return the top-k most relevant chunks
 * from their active CV.
 *
 * @param userId  Clerk user id. Scopes the search to one user's CV.
 * @param query   The user's current message. Will be embedded in-place.
 * @param k       Number of chunks to return. Default 5. The chat agent
 *                passes 6; fit-score passes 6. Keep this in the 4-8
 *                range - fewer is too thin, more crowds the prompt.
 */
export async function retrieveCvChunks(
  userId: string,
  query: string,
  k = 5,
): Promise<Citation[]> {
  // Empty query or empty user id -> nothing to do. Agents call us
  // speculatively in some paths, so this short-circuit keeps the
  // happy-path quiet and avoids an unnecessary embedding call.
  if (!userId || !query.trim()) return [];

  // 1. Embed the query. RETRIEVAL_QUERY is the right task hint for
  //    asymmetric search: we're matching a question against document
  //    chunks (which the ingester embedded with RETRIEVAL_DOCUMENT).
  const queryVec = await embedText(query, { taskType: "RETRIEVAL_QUERY" });

  // 2. RPC. The service-role client bypasses RLS, so the deny-all
  //    policy on `cv_chunks` does not block us. The RPC itself filters
  //    by `user_id = p_user_id` and joins on the single active CV.
  //    NOTE: the Pillar 2 migration (`20260605_cv.sql`) declares the
  //    third parameter as `p_top_k`, not `p_match_count`. PostgREST
  //    resolves RPCs by parameter name, so a mismatch produces the
  //    "Could not find the function … in the schema cache" error.
  const { data, error } = await supabaseAdmin.rpc("match_cv_chunks", {
    p_user_id: userId,
    p_query: queryVec,
    p_top_k: k,
  });

  if (error) {
    // Surface with context. The chat route catches this and the
    // general-chat fallback can render a friendly message; fit-score
    // and hunter let it bubble so the user sees a 500.
    throw new Error(
      `[retrieveCvChunks] match_cv_chunks failed: ${error.message}`,
    );
  }

  if (!data || data.length === 0) {
    // No active CV, or no chunks for the active CV. Agents tolerate
    // empty citations - see the prompt builders in lib/agents/*.
    return [];
  }

  // 3. Shape the RPC rows to the `Citation` contract.
  return (data as MatchRow[]).map((row) => ({
    id: row.id,
    source: row.section_label,
    text: row.content,
    score: row.similarity,
    section: row.section,
    sourceImageUrl: row.source_image_url,
  }));
}
