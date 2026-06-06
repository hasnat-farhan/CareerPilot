// CareerPilot — Goals collection endpoint.
//
//   GET  /api/goals?active=1  → list (optionally only uncompleted)
//   POST /api/goals           → create
//
// Auth: Clerk (requireUserId).

import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await requireUserId();
  const url = new URL(req.url);
  const active = url.searchParams.get("active") === "1";

  let q = supabaseAdmin
    .from("goals")
    .select("*")
    .eq("user_id", userId)
    .order("due_date", { ascending: true });

  if (active) q = q.eq("completed", false);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ goals: data ?? [] });
}

interface CreateBody {
  title?: string;
  type?: "count" | "one_shot";
  period?: "week" | "date";
  target_count?: number | null;
  due_date?: string;
}

export async function POST(req: NextRequest) {
  const userId = await requireUserId();

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.title || !body.due_date || !body.type || !body.period) {
    return NextResponse.json(
      { error: "title, due_date, type, period are required" },
      { status: 400 },
    );
  }
  if (body.type === "count" && (!body.target_count || body.target_count < 1)) {
    return NextResponse.json(
      { error: "target_count must be a positive integer for count goals" },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from("goals")
    .insert({
      user_id: userId,
      title: body.title,
      type: body.type,
      period: body.period,
      target_count: body.type === "count" ? body.target_count : null,
      due_date: body.due_date,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ goal: data });
}
