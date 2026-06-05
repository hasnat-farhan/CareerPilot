/**
 * GET    /api/cv/[id]        — fetch one CV + a chunk preview
 * GET    /api/cv/[id]/file   — short-lived signed URL for the stored PDF/DOCX
 * PATCH  /api/cv/[id]        — edit name (display label) and/or set is_active
 * DELETE /api/cv/[id]        — remove the CV, its chunks, and the storage object
 *
 * Auth: Clerk (requireUserId). All paths filter by the caller's user_id even
 * though the admin client bypasses RLS — defence in depth.
 *
 * `name` is a display-only field we keep in cvs. The migration that
 * introduces it is expected to be applied alongside this file
 * (`supabase/migrations/20260606_cv_name.sql`).
 *
 * The active-toggle respects the partial unique index
 * `cvs_one_active_per_user` by first demoting whichever row currently
 * owns the active slot for this user.
 *
 * Runtime: nodejs (service-role Supabase, storage client).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

interface CvRow {
  id: string;
  user_id: string;
  file_url: string | null;
  source: "upload" | "builder";
  status: "processing" | "ready" | "failed";
  error_message: string | null;
  is_active: boolean;
  version: number;
  name: string | null;
  created_at: string;
  updated_at: string;
}

const FULL_CHARS: number | null = null; // null = return the entire chunk body
const DEFAULT_CHUNK_LIMIT = 50;
const MAX_CHUNK_LIMIT = 500;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const { id } = await params;

  // Pagination knobs. `offset` and `limit` let the UI page through
  // long CVs without hauling every chunk in one shot. `?full=1` is
  // the explicit signal that the UI wants the entire body (the
  // default behaviour is now full-content; the flag is kept for
  // forward compatibility in case we add a "compact" mode later).
  const url = new URL(req.url);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const limit = clampInt(
    url.searchParams.get("limit"),
    DEFAULT_CHUNK_LIMIT,
    1,
    MAX_CHUNK_LIMIT,
  );
  const full = url.searchParams.get("full") !== "0"; // default true

  const { data: cv, error } = await supabaseAdmin
    .from("cvs")
    .select(
      "id, user_id, file_url, source, status, error_message, is_active, version, name, created_at, updated_at",
    )
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!cv) {
    return NextResponse.json({ error: "CV not found" }, { status: 404 });
  }

  // Chunk body — the inspector on the CV page consumes this.
  // We return the FULL `content` (no server-side truncation) so
  // the user can read every word of every chunk. The optional
  // `?full=0` switch lets future callers ask for a compact view.
  const { data: chunks, error: chunkErr } = await supabaseAdmin
    .from("cv_chunks")
    .select("id, section, section_label, ordinality, content, token_count")
    .eq("cv_id", id)
    .eq("user_id", userId)
    .order("ordinality", { ascending: true })
    .range(offset, offset + limit - 1);

  if (chunkErr) {
    return NextResponse.json({ error: chunkErr.message }, { status: 500 });
  }

  // We also need a `total` so the UI can render pagination controls
  // without doing a second round-trip.
  const { count: totalChunks, error: countErr } = await supabaseAdmin
    .from("cv_chunks")
    .select("id", { count: "exact", head: true })
    .eq("cv_id", id)
    .eq("user_id", userId);
  if (countErr) {
    return NextResponse.json({ error: countErr.message }, { status: 500 });
  }

  const rows = (chunks ?? []).map((c) => {
    const raw = (c.content as string) ?? "";
    const content = full || FULL_CHARS === null ? raw : raw.slice(0, FULL_CHARS);
    return {
      id: c.id as string,
      section: c.section as string,
      section_label: (c.section_label as string) ?? "",
      ordinality: c.ordinality as number,
      token_count: (c.token_count as number) ?? 0,
      content,
      truncated: !full && FULL_CHARS !== null && raw.length > FULL_CHARS,
    };
  });

  const row = cv as unknown as CvRow;
  return NextResponse.json({
    cv: {
      id: row.id,
      status: row.status,
      is_active: row.is_active,
      version: row.version,
      source: row.source,
      name: row.name,
      error_message: row.error_message,
      file_url: row.file_url,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    chunks: rows,
    total: totalChunks ?? rows.length,
    offset,
    limit,
  });
}

/**
 * Parse a non-negative integer query-string value. Out-of-range or
 * missing values fall back to the supplied default so the route is
 * always callable without explicit params.
 */
function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Body:
 *   { name?: string, is_active?: boolean }
 *
 * 422 if the body is missing or both fields are absent.
 * The active-toggle demotes the previous active row first, then promotes
 * the target, so the partial unique index never sees two active rows.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const { id } = await params;

  let body: { name?: unknown; is_active?: unknown };
  try {
    body = (await req.json()) as { name?: unknown; is_active?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Partial<CvRow> = {};
  let wantsName = false;
  let wantsActive = false;
  let isActiveTarget: boolean | undefined;

  if (typeof body.name === "string") {
    const trimmed = body.name.trim();
    if (trimmed.length > 200) {
      return NextResponse.json(
        { error: "name must be 200 characters or fewer" },
        { status: 422 },
      );
    }
    updates.name = trimmed.length === 0 ? null : trimmed;
    wantsName = true;
  } else if (body.name !== undefined && body.name !== null) {
    return NextResponse.json(
      { error: "name must be a string or null" },
      { status: 422 },
    );
  }

  if (typeof body.is_active === "boolean") {
    wantsActive = true;
    isActiveTarget = body.is_active;
  } else if (body.is_active !== undefined) {
    return NextResponse.json(
      { error: "is_active must be a boolean" },
      { status: 422 },
    );
  }

  if (!wantsName && !wantsActive) {
    return NextResponse.json(
      { error: "Provide at least one of: name, is_active" },
      { status: 422 },
    );
  }

  // Confirm the row exists and belongs to the caller.
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("cvs")
    .select("id, is_active, status")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "CV not found" }, { status: 404 });
  }

  // Reject activating a CV that hasn't finished ingesting.
  if (
    wantsActive &&
    isActiveTarget === true &&
    (existing.status as string) !== "ready"
  ) {
    return NextResponse.json(
      {
        error:
          "Cannot activate a CV that is not ready. " +
          `Current status: ${existing.status}.`,
      },
      { status: 409 },
    );
  }

  if (wantsActive && isActiveTarget === true && !(existing.is_active as boolean)) {
    // Demote the current active row (if any) before promoting this one.
    // Same id is a no-op since it will already be inactive by the time
    // we set is_active = true on the target.
    const { error: demoteErr } = await supabaseAdmin
      .from("cvs")
      .update({ is_active: false })
      .eq("user_id", userId)
      .eq("is_active", true)
      .neq("id", id);

    if (demoteErr) {
      return NextResponse.json({ error: demoteErr.message }, { status: 500 });
    }
    updates.is_active = true;
  } else if (wantsActive && isActiveTarget === false) {
    updates.is_active = false;
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("cvs")
    .update(updates)
    .eq("id", id)
    .eq("user_id", userId)
    .select(
      "id, user_id, file_url, source, status, error_message, is_active, version, name, created_at, updated_at",
    )
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ cv: updated });
}

/**
 * Remove a CV and all its data.
 *
 * 1. Find the row to learn the storage path (file_url holds it).
 * 2. Delete cv_chunks via FK cascade (preferred) — explicit delete is
 *    defensive in case ON DELETE CASCADE isn't wired.
 * 3. Delete the storage object.
 * 4. Delete the cvs row.
 *
 * If the storage delete fails, we still proceed (the row goes away so
 * the user isn't blocked by a dangling blob). We surface the storage
 * error in the response but with 200 because the user-facing data is gone.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const { id } = await params;

  const { data: row, error: fetchErr } = await supabaseAdmin
    .from("cvs")
    .select("id, file_url")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "CV not found" }, { status: 404 });
  }

  // Chunks first.
  const { error: chunkErr } = await supabaseAdmin
    .from("cv_chunks")
    .delete()
    .eq("cv_id", id)
    .eq("user_id", userId);

  if (chunkErr) {
    return NextResponse.json({ error: chunkErr.message }, { status: 500 });
  }

  // Row next.
  const { error: rowErr } = await supabaseAdmin
    .from("cvs")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (rowErr) {
    return NextResponse.json({ error: rowErr.message }, { status: 500 });
  }

  // Storage last. If the path can't be parsed, skip silently.
  const fileUrl = (row as unknown as { file_url: string | null }).file_url;
  const path = fileUrl ? extractStoragePath(fileUrl) : null;
  let storageWarning: string | null = null;

  if (path) {
    const { error: storageErr } = await supabaseAdmin.storage
      .from("cvs")
      .remove([path]);
    if (storageErr) {
      storageWarning = storageErr.message;
    }
  }

  return NextResponse.json({ ok: true, storageWarning });
}

/**
 * Public bucket URL forms we expect to see in `cvs.file_url`:
 *   - https://<project>.supabase.co/storage/v1/object/sign/cvs/<path>?...
 *   - https://<project>.supabase.co/storage/v1/object/public/cvs/<path>
 *   - cvs/<path>  (raw, just in case)
 *
 * We only need the object key (the part after `cvs/`), so we strip the
 * query string and pull the trailing segment.
 */
function extractStoragePath(url: string): string | null {
  try {
    const noQuery = url.split("?")[0]!;
    const marker = "/object/";
    let tail: string;
    if (noQuery.includes(marker)) {
      const after = noQuery.split(marker)[1]!;
      tail = after.split("/").slice(1).join("/");
    } else if (noQuery.startsWith("cvs/")) {
      tail = noQuery.slice(4);
    } else {
      return null;
    }
    return tail || null;
  } catch {
    return null;
  }
}
