// CareerPilot — Todos collection endpoint.
//
//   GET  /api/todos?from=YYYY-MM-DD&to=YYYY-MM-DD  → list in range
//   POST /api/todos                                 → create
//
// Auth: Clerk (requireUserId).

import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await requireUserId();
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let q = supabaseAdmin
    .from("todos")
    .select("*")
    .eq("user_id", userId)
    .order("due_date", { ascending: true });

  if (from) q = q.gte("due_date", from);
  if (to) q = q.lte("due_date", to);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ todos: data ?? [] });
}

interface CreateBody {
  title?: string;
  due_date?: string;
  goal_id?: string | null;
  application_id?: string | null;
  dedupe_key?: string | null;
}

export async function POST(req: NextRequest) {
  const userId = await requireUserId();

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.title || !body.due_date) {
    return NextResponse.json(
      { error: "title and due_date are required" },
      { status: 400 },
    );
  }

  // Idempotency: if dedupe_key is provided, look it up first.
  if (body.dedupe_key) {
    const { data: dup } = await supabaseAdmin
      .from("todos")
      .select("*")
      .eq("user_id", userId)
      .eq("dedupe_key", body.dedupe_key)
      .maybeSingle();
    if (dup) return NextResponse.json({ todo: dup, deduped: true });
  }

  const { data, error } = await supabaseAdmin
    .from("todos")
    .insert({
      user_id: userId,
      title: body.title,
      due_date: body.due_date,
      goal_id: body.goal_id ?? null,
      application_id: body.application_id ?? null,
      dedupe_key: body.dedupe_key ?? null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ todo: data });
}
