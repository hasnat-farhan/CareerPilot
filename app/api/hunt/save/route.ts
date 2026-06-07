// CareerPilot — bookmark a JobCard from a hunt result, list bookmarks,
// and un-bookmark.
//
//   GET    /api/hunt/save                  → { jobs: SavedJobCard[] }
//   POST   /api/hunt/save  { job }         → { id, alreadySaved }
//   DELETE /api/hunt/save  { url }         → { removed: boolean }
//
// The JobCard shape used to be persisted with only title / company /
// fit_score / fit_reason. We now persist the full card (snippet,
// match_highlights, concerns, breakdown, source, is_remote_fallback,
// description) so the Saved Jobs tab renders identically to the live
// hunt. Older rows survive because every new column is nullable / has
// a default in 20260607_hunter_saved_enrichment.sql.
import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { scoreFitScore } from "@/lib/agents/fitScore";
import type { JobCard } from "@/lib/agents/hunter";

// ---------- types ----------

// What the Saved Jobs tab consumes. Mirrors the live JobCard plus a
// `savedAt` timestamp and a `stale` flag — `stale` is set by GET when
// the CV has been updated after `savedAt`, signalling that the caller
// may want to re-score the card with the deterministic engine.
export type SavedJobCard = JobCard & {
  savedAt: string;
  stale: boolean;
  // The JD we fed the deterministic engine when this card was first
  // saved. We store it so the recompute path doesn't have to re-compose
  // from the snippet alone.
  description?: string;
};

type SaveBody = { job?: JobCard };
type DeleteBody = { url?: string };

// ---------- POST (bookmark) ----------

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const job = body.job;
  if (!job || !job.url || !job.title || !job.company) {
    return NextResponse.json({ error: "Missing required job fields" }, { status: 400 });
  }

  // Build a short JD text so the deterministic engine can re-score the
  // saved card later (when the user opens the Saved tab and their CV
  // has changed since savedAt). We only do the embedding + skill pull
  // in the GET path; here we just stash the description so the GET
  // route has a real JD to feed the engine.
  const jdText = composeDescription(job);

  const sb = supabaseAdmin;
  const { data, error } = await sb
    .from("hunter_saved")
    .upsert(
      {
        user_id: userId,
        url: job.url,
        title: job.title,
        company: job.company,
        location: job.location,
        salary: job.salary,
        deadline: job.deadline,
        job_type: job.jobType,
        snippet: job.snippet,
        description: jdText,
        fit_score: job.fitScore,
        fit_reason: job.fitReason,
        match_highlights: job.matchHighlights ?? [],
        concerns: job.concerns ?? [],
        breakdown: (job as JobCard & { breakdown?: unknown }).breakdown ?? null,
        source: job.source ?? null,
        is_remote_fallback: Boolean(
          (job as JobCard & { isRemoteFallback?: boolean }).isRemoteFallback,
        ),
      },
      { onConflict: "user_id,url" },
    )
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ id: data?.id, alreadySaved: true });
}

// ---------- GET (list, with stale detection + optional re-score) ----------
//
// If `?recompute=1` is set and the CV has been updated since the card
// was saved, we re-run `scoreFitScore` for each stale card and update
// the row in-place. The deterministic engine is the same function the
// Fit Score page uses, so the methodology stays identical.
export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const wantRecompute = req.nextUrl.searchParams.get("recompute") === "1";

  const sb = supabaseAdmin;

  // Find the most recent CV chunk timestamp. If the CV has been written
  // more recently than the saved card, that card is "stale".
  const { data: latestCv } = await sb
    .from("cv_chunks")
    .select("created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cvUpdatedAt = latestCv?.created_at ? new Date(latestCv.created_at as string).getTime() : 0;

  const { data: rows, error } = await sb
    .from("hunter_saved")
    .select(
      "id, url, title, company, location, salary, deadline, job_type, " +
        "snippet, description, fit_score, fit_reason, match_highlights, " +
        "concerns, breakdown, source, is_remote_fallback, saved_at",
    )
    .eq("user_id", userId)
    .order("saved_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Build stable IDs (same helper semantics as hunter.ts) and detect
  // staleness vs. CV update time. The Supabase client returns a narrow
  // row type from the generated schema; we cast through `any` so the
  // enriched columns added in the hunter_saved migration are reachable
  // without re-generating the database types.
  const cards: SavedJobCard[] = (rows ?? []).map((row: any) => {
    const savedAt = (row.saved_at as string) ?? new Date().toISOString();
    return {
      id: stableId(row.url as string),
      title: row.title as string,
      company: row.company as string,
      location: (row.location as string | null) ?? null,
      salary: (row.salary as string | null) ?? null,
      deadline: (row.deadline as string | null) ?? null,
      url: row.url as string,
      snippet: (row.snippet as string) ?? "",
      jobType: (row.job_type as string) ?? "other",
      fitScore: clampScore(row.fit_score as number | null),
      fitReason: (row.fit_reason as string) ?? "",
      matchHighlights: asStringArray(row.match_highlights),
      concerns: asStringArray(row.concerns),
      breakdown: row.breakdown ?? undefined,
      source: (row.source as string | null) ?? "unknown",
      isRemoteFallback: Boolean(row.is_remote_fallback),
      description: (row.description as string | null) ?? undefined,
      savedAt,
      stale: cvUpdatedAt > new Date(savedAt).getTime(),
    };
  });

  // Re-score stale cards with the deterministic engine. We only re-score
  // when the caller asks (the tab passes recompute=1 on mount when
  // there's at least one stale card). Failures fall back to the stored
  // snapshot — the snapshot is the safe default.
  if (wantRecompute) {
    const reScored: SavedJobCard[] = [];
    for (const card of cards) {
      if (!card.stale) {
        reScored.push(card);
        continue;
      }
      const jd = card.description || composeDescription(card);
      if (!jd.trim()) {
        reScored.push(card);
        continue;
      }
      try {
        const fresh = await scoreFitScore({ userId, jd });
        const updated: SavedJobCard = {
          ...card,
          fitScore: fresh.score,
          fitReason: fresh.rationale,
          breakdown: fresh.breakdown,
          matchHighlights: fresh.matched.slice(0, 5).map((m) => m.skill.label),
          concerns: fresh.missing.slice(0, 5).map((m) => m.skill.label),
          stale: false,
        };
        // Persist the fresh values so subsequent GETs are fast.
        await sb
          .from("hunter_saved")
          .update({
            fit_score: updated.fitScore,
            fit_reason: updated.fitReason,
            match_highlights: updated.matchHighlights,
            concerns: updated.concerns,
            breakdown: updated.breakdown,
          })
          .eq("user_id", userId)
          .eq("url", card.url);
        reScored.push(updated);
      } catch (err) {
        // Engine failed — keep the snapshot. The UI shows the stored
        // score and a small "older score" hint if desired.
        console.warn(`[hunt/save] re-score failed for ${card.url}:`, err);
        reScored.push(card);
      }
    }
    return NextResponse.json({ jobs: reScored });
  }

  return NextResponse.json({ jobs: cards });
}

// ---------- DELETE (un-bookmark) ----------

export async function DELETE(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const url = body.url;
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const sb = supabaseAdmin;
  const { error, count } = await sb
    .from("hunter_saved")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .eq("url", url);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ removed: (count ?? 0) > 0 });
}

// ---------- helpers ----------

// Same FNV-1a hash as hunter.ts:stableId, so saved cards and live cards
// share the React key + "saved" set lookups.
function stableId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `job-${h.toString(16)}`;
}

function clampScore(n: number | null | undefined): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

// Reconstruct a short JD for the deterministic engine. We have no real
// JD for saved cards (only the snippet), so the engine gets a compact
// composite of title + company + location + jobType + snippet. This is
// exactly what the hunter does when it re-scores via fitScore — it
// uses the snippet as a proxy for the JD.
function composeDescription(job: Partial<JobCard>): string {
  const parts = [
    `Title: ${job.title ?? ""}`,
    `Company: ${job.company ?? ""}`,
    job.location ? `Location: ${job.location}` : "",
    job.jobType ? `Type: ${job.jobType}` : "",
    job.salary ? `Salary: ${job.salary}` : "",
    job.snippet ?? "",
  ];
  return parts.filter(Boolean).join("\n");
}
