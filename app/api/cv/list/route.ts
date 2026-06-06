import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * GET /api/cv/list
 *
 * Returns all CVs owned by the authenticated user, newest first.
 * Used by the CV management page to populate the left column.
 *
 * Response shape:
 *   { cvs: Array<{ id, name, status, created_at, is_active, version }> }
 *
 * The DB columns are `name` (added in migration 20260606_cv_name.sql)
 * and `status` (added in migration 20260606_cv_ingest_status.sql).
 * The page maps these to the UI's `file_name` / `ingest_status` terms.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("cvs")
    .select("id, name, status, created_at, is_active, version")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `Failed to list CVs: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ cvs: data ?? [] });
}
