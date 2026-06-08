// CareerPilot — Applications collection endpoint.
//
//   GET  /api/tracker/applications          → list the caller's applications
//   POST /api/tracker/applications          → create a new application
//                                            (from a hunter_saved id, or manual)
//
// Auth: Clerk (requireUserId). Filters by user_id explicitly (RLS is deny-all).

import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await requireUserId();
  const { data, error } = await supabaseAdmin
    .from("applications")
    .select("*")
    .eq("user_id", userId)
    .order("status_updated_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ applications: data ?? [] });
}

interface CreateBody {
  source_id?: string | null;
  company?: string;
  role?: string;
  url?: string | null;
  location?: string | null;
  salary?: string | null;
  deadline?: string | null;
  notes?: string | null;
}

export async function POST(req: NextRequest) {
  const userId = await requireUserId();

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Two paths: clone from a hunter_saved row, or insert manually.
  if (body.source_id) {
    const { data: src, error: srcErr } = await supabaseAdmin
      .from("hunter_saved")
      .select("id, url, title, company, location, salary, deadline")
      .eq("id", body.source_id)
      .eq("user_id", userId)
      .single();
    if (srcErr || !src) {
      return NextResponse.json({ error: "hunter_saved row not found" }, { status: 404 });
    }

    const { data, error } = await supabaseAdmin
      .from("applications")
      .upsert(
        {
          user_id: userId,
          source_id: src.id,
          company: src.company,
          role: src.title,
          url: src.url,
          location: src.location,
          salary: src.salary,
          deadline: src.deadline || null,
          status: "applied",
          history: [{ status: "applied", at: new Date().toISOString() }],
        },
        { onConflict: "user_id,url" }
      )
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ application: data });
  }

  if (!body.company || !body.role) {
    return NextResponse.json(
      { error: "company and role are required for manual create" },
      { status: 400 },
    );
  }

  // Idempotency: if the caller re-submits a row that already exists
  // for (user_id, url), return the existing one. We can't use PostgREST
  // upsert with onConflict:"user_id,url" because the unique index is
  // a partial index (`where url is not null`), which Supabase refuses
  // to match against ON CONFLICT specifications.
  if (body.url) {
    const { data: existing, error: lookupErr } = await supabaseAdmin
      .from("applications")
      .select("*")
      .eq("user_id", userId)
      .eq("url", body.url)
      .maybeSingle();
    if (lookupErr) {
      return NextResponse.json({ error: lookupErr.message }, { status: 500 });
    }
    if (existing) {
      return NextResponse.json({ application: existing });
    }
  }

  const { data, error } = await supabaseAdmin
    .from("applications")
    .insert({
      user_id: userId,
      company: body.company,
      role: body.role,
      url: body.url ?? null,
      location: body.location ?? null,
      salary: body.salary ?? null,
      deadline: body.deadline ?? null,
      notes: body.notes ?? null,
      status: "applied",
      history: [{ status: "applied", at: new Date().toISOString() }],
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ application: data });
}
