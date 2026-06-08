/**
 * Internal warmup route for the CV upload pipeline.
 *
 * Why this exists
 * ---------------
 * The Vercel Hobby plan caps serverless functions at 10s. The CV
 * upload route on a cold start takes ~22s (route compile + PDF parse
 * + Gemini embed batch); warm runs take 3-6s. To bridge the gap we
 * warm the route on first sign-in by running the same ingest
 * pipeline against a tiny placeholder CV (`public/warmup.pdf`),
 * deleting the resulting row when it's done.
 *
 * Access control
 * --------------
 * The route requires the `x-warmup: 1` header — without it, we
 * 404. This isn't a security boundary (the request still goes
 * through Clerk / EVAL_BYPASS_AUTH), it just keeps this endpoint
 * from being an accidental public feature. The header is set by
 * the dashboard layout's `after()` callback.
 *
 * Best-effort semantics
 * ---------------------
 * The warmup is *fire-and-forget*. Any failure — Gemini 429, parse
 * error, network blip — is logged and a `200 { ok: false }` is
 * returned. The user never sees a warmup error in the UI. The
 * route is allowed to silently no-op: if a non-warmup CV already
 * exists for the user, or if the `cp_warmed` cookie is set, we
 * return `200 { ok: true, skipped: "..." }` immediately.
 */

import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  ingestCv,
  deleteCv,
  WARMUP_NAME_PREFIX,
} from "@/lib/cv/ingest";

// Same runtime config as the public upload route. The warmup is
// the *most* likely path to hit the 60s ceiling on a slow day
// (it does everything the real upload does), so the same cap
// applies.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WARMUP_HEADER = "x-warmup";
const WARMUP_FILE_NAME = `${WARMUP_NAME_PREFIX}.pdf`;

export async function POST(request: Request) {
  // (a) Refuse without the magic header. This isn't a security
  // boundary (Clerk/EVAL_BYPASS_AUTH still authorise the user),
  // just a guard against accidental public exposure.
  if (request.headers.get(WARMUP_HEADER) !== "1") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // (b) Authenticate.
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    if (err instanceof Response) return err;
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 401 },
    );
  }

  // (c) Skip if the user already has a real CV. Cheap check:
  // any non-warmup row means we've already done (or don't need)
  // a warmup. We don't gate on the cookie here because cookies
  // can be cleared; the DB check is the source of truth.
  const { data: realRow, error: realErr } = await supabaseAdmin
    .from("cvs")
    .select("id")
    .eq("user_id", userId)
    // `name` is a `text` column; the `not.like` filter excludes
    // both the warmup name and any future prefix we add.
    .not("name", "like", `${WARMUP_NAME_PREFIX}%`)
    .limit(1)
    .maybeSingle();

  if (realErr) {
    // Best-effort: log and continue. A failed lookup shouldn't
    // block a warmup we might still be able to do.
    // eslint-disable-next-line no-console
    console.warn(`[warmup] skip-check failed for ${userId}: ${realErr.message}`);
  } else if (realRow) {
    return NextResponse.json({ ok: true, skipped: "user-has-cv" });
  }

  // (d) Also skip if a warmup is already in-flight (this is a
  // second `after()` from a tab refresh, a second device, etc.).
  // We check both `processing` and `ready` — `ready` is fine to
  // skip because the warmup row will be deleted in a moment and
  // a second ingest would be wasted work.
  const { data: existingWarmup } = await supabaseAdmin
    .from("cvs")
    .select("id, status")
    .eq("user_id", userId)
    .like("name", `${WARMUP_NAME_PREFIX}%`)
    .in("status", ["processing", "ready"])
    .limit(1)
    .maybeSingle();

  if (existingWarmup) {
    return NextResponse.json({ ok: true, skipped: "already-warming" });
  }

  // (e) Read the placeholder PDF from disk. `process.cwd()` is
  // the repo root in both `next dev` and the deployed bundle, so
  // `public/warmup.pdf` resolves correctly in both environments.
  let buffer: Buffer;
  try {
    buffer = await readFile(join(process.cwd(), "public", "warmup.pdf"));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[warmup] public/warmup.pdf missing: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json(
      { ok: false, error: "warmup-asset-missing" },
      { status: 200 },
    );
  }

  // (f) Run the real ingest pipeline. Same code path the user
  // will hit on their first real upload.
  let ingestResult: { cvId: string; chunkCount: number; storagePath: string };
  try {
    ingestResult = await ingestCv({
      userId,
      fileName: WARMUP_FILE_NAME,
      buffer,
      isWarmup: true,
    });
  } catch (err) {
    // The warmup is best-effort. The error has already been
    // recorded on the row's `error_message`; just return 200
    // so the `after()` caller doesn't surface it to the user.
    // eslint-disable-next-line no-console
    console.warn(
      `[warmup] ingest failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ ok: false, error: "ingest-failed" });
  }

  // (g) Clean up. The warmup served its purpose by paying the
  // cold-start cost; the row and the storage object are
  // discarded so they don't pollute the user's CV list or
  // count against their quota.
  try {
    await deleteCv(ingestResult.cvId, userId);
    await supabaseAdmin.storage.from("cvs").remove([ingestResult.storagePath]);
  } catch (err) {
    // Cleanup failure is non-fatal: the row is in `ready` state
    // and the list route filters `__warmup__` rows out by default.
    // eslint-disable-next-line no-console
    console.warn(
      `[warmup] cleanup failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return NextResponse.json({
    ok: true,
    chunks: ingestResult.chunkCount,
    skipped: false,
  });
}
