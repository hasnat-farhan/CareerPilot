// CareerPilot — Single-todo endpoint.
//
//   PATCH  /api/todos/[id]   → toggle done, edit title/due_date
//   DELETE /api/todos/[id]   → remove

import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  done?: boolean;
  title?: string;
  due_date?: string;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const userId = await requireUserId();
  const { id } = await ctx.params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (body.title !== undefined) update.title = body.title;
  if (body.due_date !== undefined) update.due_date = body.due_date;
  if (body.done !== undefined) {
    update.done = body.done;
    update.done_at = body.done ? new Date().toISOString() : null;
  }

  const { data, error } = await supabaseAdmin
    .from("todos")
    .update(update)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ todo: data });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  const userId = await requireUserId();
  const { id } = await ctx.params;

  const { error } = await supabaseAdmin
    .from("todos")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
