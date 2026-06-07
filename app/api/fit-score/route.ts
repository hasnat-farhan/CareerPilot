/**
 * Fit-score API route.
 *
 *   POST /api/fit-score
 *     body: { jd: string, benchmarkKey?: string, persist?: boolean }
 *     → 200 FitScoreResult
 *
 *   GET /api/fit-score
 *     → 200 { latest: FitScoreResult | null }
 *
 * Drives both the static fit-score page and the assistant's specialised
 * sub-agents. The actual scoring lives in `lib/agents/fitScore.ts`.
 */

import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { scoreFitScore, getLatestFitScore, type FitScoreResult } from "@/lib/agents/fitScore";
import { supabaseAdmin } from "@/lib/supabase/admin";
import crypto from "node:crypto";

export const runtime = "nodejs";

const MAX_JD_CHARS = 24_000; // ~6k tokens; protects against pathological inputs

function hashJd(jd: string): string {
  return crypto.createHash("sha256").update(jd.trim().toLowerCase()).digest("hex").slice(0, 24);
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  let body: { jd?: string; benchmarkKey?: string; persist?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const jd = typeof body.jd === "string" ? body.jd.trim() : "";
  const benchmarkKey = typeof body.benchmarkKey === "string" ? body.benchmarkKey.trim() : undefined;
  const persist = body.persist !== false; // default true

  if (!jd) return NextResponse.json({ error: "missing_jd" }, { status: 400 });
  if (jd.length > MAX_JD_CHARS) {
    return NextResponse.json({ error: "jd_too_long", max: MAX_JD_CHARS }, { status: 400 });
  }
  if (!jd && !benchmarkKey) {
    return NextResponse.json({ error: "missing_inputs" }, { status: 400 });
  }

  let result: FitScoreResult;
  try {
    result = await scoreFitScore({ userId, jd, ...(benchmarkKey ? { benchmarkKey } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "scoring_failed";
    return NextResponse.json({ error: "scoring_failed", message }, { status: 500 });
  }

  if (persist) {
    // Fire-and-await the insert; if it fails we still return the result
    // (caller can retry). Don't block the user.
    const { error } = await supabaseAdmin.from("fit_scores").insert({
      user_id: userId,
      benchmark_key: result.benchmarkUsed,
      jd_hash: hashJd(jd),
      jd_excerpt: jd.slice(0, 8_000),
      result: { ...result, citations: [] }, // strip citations from the row
    });
    if (error) {
      // Surface in dev logs; don't 500 the response.
      console.warn("[fit-score] persist failed:", error.message);
    }
  }

  return NextResponse.json({ result });
}

export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  const latest = await getLatestFitScore(userId);
  return NextResponse.json({ latest });
}
