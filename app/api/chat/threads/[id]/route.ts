import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * GET /api/chat/threads/[id]
 *
 * Fetch a single thread and its full message history. Used when the
 * user clicks a thread in the sidebar.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const { id } = await params;

  // Ownership check first — fail fast if this thread isn't the user's.
  const { data: thread, error: tErr } = await supabaseAdmin
    .from("chat_threads")
    .select("id, title, updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (tErr || !thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const { data: messages, error: mErr } = await supabaseAdmin
    .from("chat_messages")
    .select(
      "id, role, content, citations, mode, structured_result, created_at",
    )
    .eq("thread_id", id)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (mErr) {
    return NextResponse.json({ error: mErr.message }, { status: 500 });
  }

  // The page consumes `message.structured` (a `StructuredPayload` object),
  // not the raw column name. The DB column is `structured_result` (the
  // payload produced by the assistant agent). Rename on the way out so the
  // page's discriminated-union renderer can find it. `mode` passes through
  // unchanged.
  const shaped = (messages ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    citations: m.citations ?? [],
    mode: m.mode ?? null,
    structured: m.structured_result ?? null,
    created_at: m.created_at,
  }));

  return NextResponse.json({ thread, messages: shaped });
}

/**
 * DELETE /api/chat/threads/[id]
 *
 * Delete a thread (and all its messages via the ON DELETE CASCADE FK).
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const { id } = await params;

  const { error } = await supabaseAdmin
    .from("chat_threads")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/chat/threads/[id]
 *
 * Rename a thread. Body: `{ title: string }`.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  if (!body.title || !body.title.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("chat_threads")
    .update({ title: body.title.trim().slice(0, 200) })
    .eq("id", id)
    .eq("user_id", userId)
    .select("id, title, updated_at")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to rename" },
      { status: 500 },
    );
  }

  return NextResponse.json({ thread: data });
}
