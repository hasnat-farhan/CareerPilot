import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * GET /api/chat/threads
 *
 * List the current user's chat threads, most-recently-updated first.
 * Includes a `message_count` so the sidebar can show "(3)" style hints
 * without an N+1.
 */
export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const { data, error } = await supabaseAdmin
    .from("chat_threads")
    .select("id, title, updated_at, chat_messages(count)")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Flatten the embedded count relation into a plain number.
  const threads = (data ?? []).map((row) => {
    const rel = row.chat_messages as unknown as Array<{ count: number }> | null;
    return {
      id: row.id as string,
      title: row.title as string,
      updated_at: row.updated_at as string,
      message_count: rel?.[0]?.count ?? 0,
    };
  });

  return NextResponse.json({ threads });
}

/**
 * POST /api/chat/threads
 *
 * Create a new empty thread. The body is optional: `{ title?: string }`.
 * Returns the new thread's id.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  let title = "New chat";
  try {
    const body = (await req.json()) as { title?: string };
    if (body.title && typeof body.title === "string" && body.title.trim()) {
      title = body.title.trim().slice(0, 200);
    }
  } catch {
    // Empty body is fine — defaults apply.
  }

  const { data, error } = await supabaseAdmin
    .from("chat_threads")
    .insert({ user_id: userId, title })
    .select("id, title, updated_at")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to create thread" },
      { status: 500 },
    );
  }

  return NextResponse.json({ thread: data });
}
