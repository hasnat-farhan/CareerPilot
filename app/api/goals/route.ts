// CareerPilot — Goals collection endpoint.
//
//   GET  /api/goals[?active=1]   → list goals (filter completed=false when active=1)
//   POST /api/goals              → create a new goal
//
// Auth: Clerk (requireUserId). Filters by user_id explicitly.
import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }
  const url = new URL(req.url);
  const active = url.searchParams.get("active");

  let q = supabaseAdmin
    .from("goals")
    .select("*")
    .eq("user_id", userId)
    .order("due_date", { ascending: true });
  if (active === "1") q = q.eq("completed", false);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ goals: data ?? [] });
}

interface CreateBody {
  title?: string;
  type?: "count" | "one_shot";
  target_count?: number | null;
  period?: "week" | "date";
  due_date?: string;
  application_id?: string | null;
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.title || !body.due_date || !body.type || !body.period) {
    return NextResponse.json(
      { error: "title, type, period, and due_date are required" },
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
      target_count: body.target_count ?? null,
      due_date: body.due_date,
      completed: false,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ goal: data });
}
