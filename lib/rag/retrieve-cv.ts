import { supabaseAdmin } from "@/lib/supabase/admin";
import { embedText } from "@/lib/ai/provider";

export interface Citation {
  id: string;
  source: string;
  text: string;
  score: number;
}

export async function retrieveCvChunks(
  userId: string,
  query: string,
  topK = 5,
): Promise<Citation[]> {
  // 1. Embed the query
  let queryVec: number[];
  try {
    queryVec = await embedText(query, { taskType: "RETRIEVAL_QUERY" });
  } catch (err) {
    console.error("[retrieve-cv] embed failed", err);
    return [];
  }

  // 2. Call match_cv_chunks RPC (filters by user_id + is_active CV internally)
  const { data, error } = await supabaseAdmin.rpc("match_cv_chunks", {
    p_user_id: userId,
    p_query: queryVec,
    p_top_k: topK,
  });

  if (error) {
    console.error("[retrieve-cv] match_cv_chunks RPC error", error);
    return [];
  }

  return (data ?? []).map((row: {
    id: string;
    section: string;
    section_label: string;
    content: string;
    source_image_url: string | null;
    similarity: number;
  }) => ({
    id: row.id,
    source: row.section_label ?? row.section,
    text: row.content,
    score: row.similarity,
  }));
}
