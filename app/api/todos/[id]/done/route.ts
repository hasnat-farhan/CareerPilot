// CareerPilot — Mark a todo as done.
//
//   PATCH /api/todos/[id]/done   → sets done=true, done_at=now()
//
// Auth: Clerk (requireUserId). Filters by user_id explicitly.
// The companion `PATCH /api/todos/[id]` route already supports toggling
// `done`; this dedicated subroute is what the eval suite calls.
import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(_req: NextRequest, ctx: RouteCtx) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }
  const { id } = await ctx.params;

  const { data, error } = await supabaseAdmin
    .from("todos")
    .update({
      done: true,
      done_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Todo not found" },
      { status: 500 },
    );
  }
  return NextResponse.json({ todo: data });
}
