// CareerPilot — Job Hunter API.
//
//   GET  /api/hunt          → list the user's recent hunts (sidebar)
//   POST /api/hunt          → { query, forceRefresh? } → run hunter, cache result
//   POST /api/hunt/save     → bookmark a card from a hunt
//
// Caching:
//   Per (user_id, query_hash) we keep ONE row in hunter_hunts. The
//   expires_at column governs whether the next call returns the cached
//   payload or re-runs the agent. forceRefresh=true always re-runs.

import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { runHunter, normaliseQuery, type JobCard, type HunterResult } from "@/lib/agents/hunter";
import crypto from "node:crypto";

// ---------- helpers ----------

function hashQuery(q: string): string {
  return crypto.createHash("sha256").update(normaliseQuery(q)).digest("hex").slice(0, 32);
}

function rowToResult(row: Record<string, unknown>): HunterResult & { cachedAt: string } {
  const r = row.result as Partial<HunterResult>;
  return {
    query: row.query as string,
    jobs: r.jobs ?? [],
    reasoning: r.reasoning ?? "",
    model: r.model ?? "gemini-2.5-flash",
    retrievedAt: r.retrievedAt ?? new Date().toISOString(),
    sourcesUsed: r.sourcesUsed ?? [],
    totalCandidates: r.totalCandidates ?? 0,
    degraded: r.degraded ?? undefined,
    cachedAt: row.refreshed_at as string,
  };
}

// ---------- GET (list) ----------

export async function GET() {
  const userId = await requireUserId();
  const sb = supabaseAdmin;
  const { data, error } = await sb
    .from("hunter_hunts")
    .select("id, query, refreshed_at, expires_at")
    .eq("user_id", userId)
    .order("refreshed_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ hunts: data ?? [] });
}

// ---------- POST (run) ----------

export async function POST(req: NextRequest) {
  const userId = await requireUserId();

  let body: { query?: string; forceRefresh?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const query = (body.query ?? "").trim();
  if (query.length < 3) {
    return NextResponse.json({ error: "Query must be at least 3 characters" }, { status: 400 });
  }
  if (query.length > 500) {
    return NextResponse.json({ error: "Query is too long (max 500 chars)" }, { status: 400 });
  }

  const sb = supabaseAdmin;
  const queryHash = hashQuery(query);
  const now = new Date();

  // Cache hit check.
  if (!body.forceRefresh) {
    const { data: existing } = await sb
      .from("hunter_hunts")
      .select("*")
      .eq("user_id", userId)
      .eq("query_hash", queryHash)
      .maybeSingle();

    if (existing && new Date(existing.expires_at as string) > now) {
      return NextResponse.json({ ...rowToResult(existing), cached: true });
    }
  }

  // Run the agent.
  let result: HunterResult;
  try {
    result = await runHunter(userId, query);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown agent error";
    return NextResponse.json({ error: `Hunter failed: ${message}` }, { status: 502 });
  }

  // Upsert: replace any previous row for this (user, query_hash).
  await sb
    .from("hunter_hunts")
    .delete()
    .eq("user_id", userId)
    .eq("query_hash", queryHash);

  const { error: writeErr } = await sb.from("hunter_hunts").insert({
    user_id: userId,
    query,
    query_hash: queryHash,
    result: {
      jobs: result.jobs,
      reasoning: result.reasoning,
      model: result.model,
      retrievedAt: result.retrievedAt,
      sourcesUsed: result.sourcesUsed,
      totalCandidates: result.totalCandidates,
      degraded: result.degraded ?? null,
    },
    // 1-hour TTL. The DB column default is 30 minutes, but we override
    // explicitly so the cache behaviour is owned by the route (and so a
    // later migration can change the default without changing behaviour).
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  if (writeErr) {
    // Don't fail the user — they got their answer, we just couldn't cache it.
    console.error("[hunt] cache write failed:", writeErr.message);
  }

  return NextResponse.json({ ...result, cached: false });
}
