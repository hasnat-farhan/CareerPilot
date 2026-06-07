/**
 * Fit-score API route.
 *
 *   POST /api/fit-score
 *     body: {
 *       jd?: string,             // raw job description text (optional if role set)
 *       benchmarkKey?: string,   // static key from lib/data/benchmarks
 *       role?: string,           // free-text role name → synthesise a benchmark
 *       persist?: boolean,       // default true; set false to skip the insert
 *     }
 *     → 200 { result: FitScoreResult }
 *
 *   GET /api/fit-score
 *     → 200 { latest: FitScoreResult | null }
 *
 * Drives both the static fit-score page and the assistant's specialised
 * sub-agents. The actual scoring lives in `lib/agents/fitScore.ts`.
 *
 * Input contract: at least ONE of `jd` or `role` is required. `role` runs
 * through `getOrSynthesiseBenchmark` (cached, anchored in the user's CV)
 * and produces a `RoleBenchmark` we use as the structural scorer. If both
 * are sent, the role synthesises the benchmark and the JD is fed to the
 * rationale + extra-skill step inside `scoreFitScore`.
 */

import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { scoreFitScore, getLatestFitScore, type FitScoreResult } from "@/lib/agents/fitScore";
import { getOrSynthesiseBenchmark } from "@/lib/data/benchmarks/dynamic";
import { supabaseAdmin } from "@/lib/supabase/admin";
import crypto from "node:crypto";

export const runtime = "nodejs";

const MAX_JD_CHARS = 24_000; // ~6k tokens; protects against pathological inputs
const MAX_ROLE_CHARS = 200;  // free-text role names should be short

function hashJd(jd: string): string {
  return crypto
    .createHash("sha256")
    .update(jd.trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  let body: {
    jd?: string;
    benchmarkKey?: string;
    role?: string;
    persist?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const jd = typeof body.jd === "string" ? body.jd.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  const benchmarkKey =
    typeof body.benchmarkKey === "string" ? body.benchmarkKey.trim() : undefined;
  const persist = body.persist !== false; // default true

  if (!jd && !role && !benchmarkKey) {
    return NextResponse.json(
      { error: "missing_inputs", message: "Provide a job description, a role name, or a benchmark key." },
      { status: 400 },
    );
  }
  if (jd.length > MAX_JD_CHARS) {
    return NextResponse.json(
      { error: "jd_too_long", max: MAX_JD_CHARS },
      { status: 400 },
    );
  }
  if (role.length > MAX_ROLE_CHARS) {
    return NextResponse.json(
      { error: "role_too_long", max: MAX_ROLE_CHARS },
      { status: 400 },
    );
  }

  // Resolve the benchmark. Resolution order:
  //   1. `role` (free-text) → dynamic synthesis anchored on the user's CV
  //   2. `benchmarkKey`    → static registry lookup (lib/data/benchmarks)
  //   3. neither           → jd-only ("_freeform" benchmark inside the scorer)
  let inlineBenchmark = undefined as
    | Awaited<ReturnType<typeof getOrSynthesiseBenchmark>>
    | undefined;

  if (role) {
    try {
      inlineBenchmark = await getOrSynthesiseBenchmark(userId, role);
    } catch (err) {
      const message = err instanceof Error ? err.message : "benchmark_synthesis_failed";
      return NextResponse.json(
        { error: "benchmark_synthesis_failed", message },
        { status: 500 },
      );
    }
  }

  // Score.
  let result: FitScoreResult;
  try {
    result = await scoreFitScore({
      userId,
      // Always pass jd when we have it — the scorer uses it for the rationale
      // and as an extra skill-signal even when a benchmark is present.
      ...(jd ? { jd } : {}),
      ...(inlineBenchmark
        ? { benchmark: inlineBenchmark }
        : benchmarkKey
          ? { benchmarkKey }
          : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "scoring_failed";
    return NextResponse.json({ error: "scoring_failed", message }, { status: 500 });
  }

  if (persist) {
    // Use the role as the persisted "JD" so the dashboard preview surfaces
    // what the user actually typed. Falls back to the raw jd for jd-only runs.
    const persistedExcerptSource = role
      ? `Role: ${role}${jd ? `\n\n${jd}` : ""}`
      : jd;
    const { error } = await supabaseAdmin.from("fit_scores").insert({
      user_id: userId,
      benchmark_key: result.benchmarkUsed,
      jd_hash: hashJd(persistedExcerptSource || role || "freeform"),
      jd_excerpt: persistedExcerptSource.slice(0, 8_000),
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
