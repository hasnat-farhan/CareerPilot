import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { WARMUP_NAME_PREFIX } from "@/lib/cv/ingest";

/**
 * GET /api/cv/list
 *
 * Returns all CVs owned by the authenticated user, newest first.
 * Used by the CV management page to populate the left column.
 *
 * Response shape:
 *   { cvs: Array<{ id, name, status, created_at, is_active, version }> }
 *
 * Query params
 * ------------
 *   ?warmup=1   Include the internal `__warmup__` placeholder row
 *               used by the cold-start warmup. Default: omit. The
 *               public UI never asks for this; the warmup provider
 *               polls it to know when the background ingest has
 *               finished (or been cleaned up).
 *
 * The DB columns are `name` (added in migration 20260606_cv_name.sql)
 * and `status` (added in migration 20260606_cv_ingest_status.sql).
 * The page maps these to the UI's `file_name` / `ingest_status` terms.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const includeWarmup = url.searchParams.get("warmup") === "1";

  let query = supabaseAdmin
    .from("cvs")
    .select("id, name, status, created_at, is_active, version")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (!includeWarmup) {
    // The warmup row is tagged by name prefix (see lib/cv/ingest.ts
    // and the `_warmup` route). The `not.like` filter excludes any
    // current or future warmup-prefixed name from the public list.
    query = query.not("name", "like", `${WARMUP_NAME_PREFIX}%`);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json(
      { error: `Failed to list CVs: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ cvs: data ?? [] });
}
