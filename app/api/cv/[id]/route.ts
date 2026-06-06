import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * DELETE /api/cv/[id]
 *
 * Deletes a CV and all of its chunks. Used by the CV management page.
 *
 * Order matters: `cv_chunks` has an FK on `cv_id` with `on delete cascade`,
 * but we still issue the explicit chunk delete first so the chunk count
 * is observable in the response and the call is robust to the cascade
 * ever being removed.
 *
 * The `user_id = userId` filter is the ownership check — RLS is bypassed
 * by the admin client, so a leaked userId could otherwise delete another
 * user's row. Both deletes must succeed in the same call; if either
 * fails (other than a no-op), we return 500.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
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

  // Delete chunks first.
  const { error: chunksError, count: chunksDeleted } = await supabaseAdmin
    .from("cv_chunks")
    .delete({ count: "exact" })
    .eq("cv_id", id)
    .eq("user_id", userId);

  if (chunksError) {
    return NextResponse.json(
      { error: `Failed to delete chunks: ${chunksError.message}` },
      { status: 500 },
    );
  }

  // Then the cv row itself.
  const { error: cvError, count: cvDeleted } = await supabaseAdmin
    .from("cvs")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", userId);

  if (cvError) {
    return NextResponse.json(
      { error: `Failed to delete CV: ${cvError.message}` },
      { status: 500 },
    );
  }

  if (cvDeleted === 0) {
    return NextResponse.json(
      { error: "CV not found or not owned by user" },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, chunks_deleted: chunksDeleted ?? 0 });
}
