/**
 * RAG retrieval seam.
 *
 * The chat route calls this to fetch relevant chunks from the user's CV
 * before composing the prompt. Right now it returns an empty list because
 * the CV ingester (`lib/cv/ingester.ts`) hasn't been built yet.
 *
 * Once the ingester lands and populates `cv_chunks` with 3072-dim
 * embeddings, swap the body of `retrieveCvChunks` for a real pgvector
 * query and nothing else needs to change. The `Citation` shape is what
 * the API route serialises to the client, so keep it stable.
 */

import { embedText } from "@/lib/ai/provider";

export interface Citation {
  /** Stable identifier for the chunk (matches cv_chunks.id once ingester ships). */
  id: string;
  /** Human-readable label, e.g. "CV > Experience > Acme Corp (2024)". */
  source: string;
  /** Chunk text verbatim — rendered as the citation body in the UI. */
  text: string;
  /** Cosine similarity, 0..1. */
  score: number;
}

/**
 * Embed the user's question and return the top-k relevant CV chunks.
 *
 * @param userId  Clerk user id (scopes the search to one user's CV).
 * @param query   The user's current message.
 * @param k       Number of chunks to return (default 4).
 */
export async function retrieveCvChunks(
  userId: string,
  query: string,
  k = 4,
): Promise<Citation[]> {
  // STEP 1: keep the import live so future code can call embedText()
  // without re-plumbing the import. Cheap; the call itself is gated below.
  void embedText;

  // TODO(cv): replace with a real pgvector query once the ingester ships.
  //
  // Pseudocode for the real implementation:
  //   const qVec = await embedText(query, { taskType: "RETRIEVAL_QUERY" });
  //   const { data } = await supabaseAdmin.rpc("match_cv_chunks", {
  //     p_user_id: userId,
  //     p_query_embedding: qVec,
  //     p_match_count: k,
  //   });
  //   return (data ?? []).map((row) => ({ id: row.id, source: row.source, text: row.content, score: row.similarity }));
  void userId;
  void query;
  void k;
  return [];
}
