import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Routes on /api/cv/[id]:
 *
 *  - DELETE  → drop chunks then drop the cv row
 *  - PATCH   → rename and/or set `is_active = true` (the activate flow)
 *
 * Activate flow
 * -------------
 * The DB has a partial unique index `cvs_one_active_per_user` on
 * `(user_id) WHERE is_active = true` so a user can have at most one
 * active CV. To flip a CV active we therefore:
 *
 *   1. Demote any existing active row for this user to `is_active=false`.
 *   2. Promote the target row to `is_active=true`.
 *
 * Doing the demote *first* avoids racing against the partial unique
 * index (which would reject a second `is_active=true` insert). If the
 * demote succeeds and the promote fails, the user has zero active CVs,
 * which is recoverable (they re-click Activate).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/cv/[id]
 *
 * Body: { name?: string, is_active?: boolean }
 *
 * - If `is_active = true`, demotes the user's current active CV
 *   before promoting this one. Done in two writes (no transaction
 *   wrapper on the supabase-js admin client) — the partial unique
 *   index is the safety net.
 * - If `is_active = false`, just flips the row inactive. Other rows
 *   are not affected.
 * - The CV must belong to the calling user (defence in depth on
 *   top of RLS).
 */
export async function PATCH(
  request: Request,
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

  let body: { name?: string; is_active?: boolean };
  try {
    body = (await request.json()) as { name?: string; is_active?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Verify ownership up front; the update filter is also scoped, but
  // a 404 here gives clearer errors than "0 rows updated".
  const { data: owned, error: ownErr } = await supabaseAdmin
    .from("cvs")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (ownErr) {
    return NextResponse.json(
      { error: `Lookup failed: ${ownErr.message}` },
      { status: 500 },
    );
  }
  if (!owned) {
    return NextResponse.json(
      { error: "CV not found or not owned by user" },
      { status: 404 },
    );
  }

  // (a) Activate: demote prior active, then promote.
  if (body.is_active === true) {
    const { error: demoteErr } = await supabaseAdmin
      .from("cvs")
      .update({ is_active: false })
      .eq("user_id", userId)
      .eq("is_active", true)
      .neq("id", id);

    if (demoteErr) {
      return NextResponse.json(
        { error: `Failed to demote prior active CV: ${demoteErr.message}` },
        { status: 500 },
      );
    }

    const { error: promoteErr } = await supabaseAdmin
      .from("cvs")
      .update({ is_active: true })
      .eq("id", id)
      .eq("user_id", userId);

    if (promoteErr) {
      return NextResponse.json(
        { error: `Failed to activate CV: ${promoteErr.message}` },
        { status: 500 },
      );
    }
  } else if (body.is_active === false) {
    const { error: demoteErr } = await supabaseAdmin
      .from("cvs")
      .update({ is_active: false })
      .eq("id", id)
      .eq("user_id", userId);

    if (demoteErr) {
      return NextResponse.json(
        { error: `Failed to deactivate CV: ${demoteErr.message}` },
        { status: 500 },
      );
    }
  }

  // (b) Rename (independent of is_active; can be combined).
  if (typeof body.name === "string") {
    const trimmed = body.name.trim();
    if (trimmed.length === 0) {
      return NextResponse.json(
        { error: "name cannot be empty" },
        { status: 400 },
      );
    }
    if (trimmed.length > 200) {
      return NextResponse.json(
        { error: "name too long (max 200 chars)" },
        { status: 400 },
      );
    }
    const { error: renameErr } = await supabaseAdmin
      .from("cvs")
      .update({ name: trimmed })
      .eq("id", id)
      .eq("user_id", userId);

    if (renameErr) {
      return NextResponse.json(
        { error: `Failed to rename CV: ${renameErr.message}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ success: true, id, ...body });
}

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
