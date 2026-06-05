/**
 * GET /api/cv
 *
 * List the current user's CVs, most-recently-uploaded first.
 * Returns a flat shape the dashboard can render without an
 * N+1: chunk count comes back as a side relation, just like
 * the chat threads route.
 *
 * Response:
 *   { cvs: CvSummary[] }
 *
 * `CvSummary`:
 *   {
 *     id, status, is_active, version, source,
 *     created_at, updated_at, error_message,
 *     chunk_count, file_size
 *   }
 *
 * Auth: Clerk (requireUserId).
 * Runtime: nodejs — service-role Supabase access.
 */

import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

interface CvRow {
  id: string;
  user_id: string;
  file_url: string | null;
  source: "upload" | "builder";
  status: "processing" | "ready" | "failed";
  error_message: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  // Single round-trip: cvs + their chunk counts.
  const { data, error } = await supabaseAdmin
    .from("cvs")
    .select(
      "id, user_id, file_url, source, status, error_message, is_active, version, created_at, updated_at, cv_chunks(count)",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const cvs = (data ?? []).map((row) => {
    const r = row as unknown as CvRow & {
      cv_chunks: Array<{ count: number }> | null;
    };
    return {
      id: r.id,
      status: r.status,
      is_active: r.is_active,
      version: r.version,
      source: r.source,
      error_message: r.error_message,
      created_at: r.created_at,
      updated_at: r.updated_at,
      chunk_count: r.cv_chunks?.[0]?.count ?? 0,
    };
  });

  return NextResponse.json({ cvs });
}
