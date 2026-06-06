import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * GET /api/cv/[id]/chunks
 *
 * Returns every chunk belonging to a single CV. Used by the CV
 * management page's "Chunks" tab.
 *
 * Response shape:
 *   { chunks: Array<{ id, section, content, ordinality, token_count }> }
 *
 * The `user_id = userId` filter is the ownership check; the `cv_id = id`
 * filter scopes to the requested CV. The page additionally matches the
 * `cv_id` against `selectedCv.id` so a user can't view another user's
 * chunks by guessing an id — the API will return [] for them.
 *
 * Ordered by `section` then `ordinality` so the chunks come back in the
 * same order the ingester wrote them.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing CV id" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("cv_chunks")
    .select("id, section, content, ordinality, token_count")
    .eq("cv_id", id)
    .eq("user_id", userId)
    .order("section", { ascending: true })
    .order("ordinality", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: `Failed to load chunks: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ chunks: data ?? [] });
}
