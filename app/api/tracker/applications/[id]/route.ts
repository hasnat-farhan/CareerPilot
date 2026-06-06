// CareerPilot — Single-application endpoint.
//
//   PATCH  /api/tracker/applications/[id]   → status / notes
//   DELETE /api/tracker/applications/[id]   → remove
//
// Auth: Clerk (requireUserId). Filters by user_id explicitly.

import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/productivity/types";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  status?: ApplicationStatus;
  notes?: string | null;
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

  // Load the existing row to merge into history.
  const { data: existing, error: loadErr } = await supabaseAdmin
    .from("applications")
    .select("id, status, history")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (loadErr || !existing) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  if (body.notes !== undefined) update.notes = body.notes;
  if (body.status && APPLICATION_STATUSES.includes(body.status)) {
    if (body.status !== existing.status) {
      const prev = Array.isArray(existing.history) ? existing.history : [];
      const next = [
        ...prev,
        { status: body.status, at: new Date().toISOString() },
      ];
      update.status = body.status;
      update.history = next;
      update.status_updated_at = new Date().toISOString();
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ application: existing });
  }

  const { data, error } = await supabaseAdmin
    .from("applications")
    .update(update)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ application: data });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  const userId = await requireUserId();
  const { id } = await ctx.params;

  const { error } = await supabaseAdmin
    .from("applications")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
