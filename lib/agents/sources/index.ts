// Source registry + parallel fan-out + dedupe.
//
// Each individual source (remoteok, arbeitnow, themuse, adzuna) is a small
// JobSource module. This file composes them:
//   - parseQuery()  →  light, deterministic role/location extraction
//   - fanOutSearch() →  Promise.allSettled so one bad source can't kill the run
//   - dedupe()      →  URL canonicalisation + fuzzy (title, company, city) match
//
// A failed/unavailable source returns an empty array and we log the reason.

import { remoteokSource } from "./remoteok";
import { arbeitnowSource } from "./arbeitnow";
import { themuseSource } from "./themuse";
import { adzunaSource } from "./adzuna";
import type { JobSource, RawJob } from "./types";

export const SOURCES: JobSource[] = [
  remoteokSource,
  arbeitnowSource,
  themuseSource,
  adzunaSource,
];

export type ParsedQuery = {
  role: string;
  location: string | null;
};

// Cheap, deterministic query parser. Keeps the original role terms together
// (e.g. "senior backend engineer" stays one phrase) and pulls the last
// comma-separated chunk as the location when present.
export function parseQuery(query: string): ParsedQuery {
  const trimmed = query.trim();
  if (!trimmed) return { role: "", location: null };

  // "software engineer in london" → role="software engineer", loc="london"
  const inMatch = trimmed.match(/^(.+?)\s+in\s+(.+)$/i);
  if (inMatch && inMatch[1] && inMatch[2]) {
    return { role: inMatch[1].trim(), location: inMatch[2].trim() };
  }
  // "backend engineer, dhaka" → role="backend engineer", loc="dhaka"
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",");
    const head = parts[0];
    if (head !== undefined) {
      const loc = parts.slice(1).join(",").trim();
      if (loc) return { role: head.trim(), location: loc };
    }
  }
  return { role: trimmed, location: null };
}

// Run every enabled source in parallel. allSettled guarantees we still get
// results from the healthy ones if one source throws or rate-limits.
//
// When the user specified a location, we fan out twice: once with the
// location filter (so city-specific postings surface) and once WITHOUT it
// (so remote-friendly postings aren't suppressed by the location constraint).
// This matches the "add remote positions regardless of locations" UX rule.
export async function fanOutSearch(query: string): Promise<RawJob[]> {
  const parsed = parseQuery(query);
  if (!parsed.role) return [];
  const hasLocation = !!parsed.location?.trim();

  // Build a list of (source, opts) jobs to run in parallel.
  const jobs: Array<{ s: JobSource; opts?: { location?: string; page?: number; rawQuery?: string } }> = [];
  for (const s of SOURCES) {
    jobs.push({ s, opts: { location: parsed.location ?? undefined, rawQuery: query } });
    if (hasLocation) {
      // second pass: drop the location so we still get remote roles
      jobs.push({ s, opts: { rawQuery: query } });
    }
  }

  const settled = await Promise.allSettled(
    jobs.map((j) => j.s.search(parsed.role, j.opts))
  );
  const merged: RawJob[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      merged.push(...r.value);
    } else {
      const src = jobs[i]?.s;
      console.warn(
        `[sources] ${src?.name ?? `source[${i}]`} failed:`,
        (r.reason as Error)?.message ?? r.reason
      );
    }
  });
  return dedupe(merged);
}

// --- dedupe helpers ---

function canonicalUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    // strip common tracking params
    for (const k of Array.from(url.searchParams.keys())) {
      if (/^utm_/i.test(k) || k === "ref" || k === "fbclid" || k === "gclid") {
        url.searchParams.delete(k);
      }
    }
    return url.toString().toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function cityFromLocation(loc: string | null): string {
  if (!loc) return "";
  // First comma-separated chunk, lowercased
  const first = loc.split(",")[0];
  return (first ?? "").trim().toLowerCase();
}

// Levenshtein distance — small, no dependencies, used for fuzzy match
function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1] ?? "";
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j] ?? 0;
      const bj = b[j - 1] ?? "";
      const cost = ai === bj ? prev : Math.min(prev, dp[j] ?? 0, dp[j - 1] ?? 0) + 1;
      dp[j] = cost;
      prev = tmp;
    }
  }
  return dp[n] ?? 0;
}

function fuzzyClose(a: string, b: string, maxDist = 3): boolean {
  if (Math.abs(a.length - b.length) > maxDist) return false;
  return lev(a, b) <= maxDist;
}

export function dedupe(jobs: RawJob[]): RawJob[] {
  const seenUrl = new Map<string, RawJob>();
  const buckets: RawJob[] = []; // after URL dedupe, for fuzzy pass

  for (const j of jobs) {
    const key = canonicalUrl(j.url ?? "");
    if (seenUrl.has(key)) {
      // keep the more informative one (snippet length is a decent proxy)
      const prev = seenUrl.get(key)!;
      if ((j.snippet?.length ?? 0) > (prev.snippet?.length ?? 0)) {
        seenUrl.set(key, j);
      }
      continue;
    }
    seenUrl.set(key, j);
    buckets.push(j);
  }

  // Fuzzy pass — same (company, title, city) within a few edits collapses
  const out: RawJob[] = [];
  for (const j of buckets) {
    const city = cityFromLocation(j.location);
    const titleN = j.title.toLowerCase().trim();
    const coN = j.company.toLowerCase().trim();
    const dup = out.find(
      (k) =>
        fuzzyClose(k.title.toLowerCase().trim(), titleN, 3) &&
        fuzzyClose(k.company.toLowerCase().trim(), coN, 2) &&
        cityFromLocation(k.location) === city
    );
    if (dup) {
      // prefer the one with a salary or a later postedAt
      const jScore = (j.salary ? 1 : 0) + (j.postedAt ? 1 : 0);
      const dScore = (dup.salary ? 1 : 0) + (dup.postedAt ? 1 : 0);
      if (jScore > dScore) {
        const idx = out.indexOf(dup);
        out[idx] = j;
      }
    } else {
      out.push(j);
    }
  }

  // sort: has salary first, then most recent posted
  return out.sort((a, b) => {
    const aS = a.salary ? 1 : 0;
    const bS = b.salary ? 1 : 0;
    if (aS !== bS) return bS - aS;
    const ad = a.postedAt ? new Date(a.postedAt).getTime() : 0;
    const bd = b.postedAt ? new Date(b.postedAt).getTime() : 0;
    return bd - ad;
  });
}

// --- location relevance ranking ---
//
// Used by the hunter agent to bias the LLM-facing candidate list toward
// local matches first, then remote, then everything else. The same
// helper backs the "exclusive remote fallback" branch: if the user
// asked for a specific city and zero local cards exist, the hunter
// reuses these partitions to surface exclusively-remote roles.

export const REMOTE_LOC_HINTS = /\b(remote|anywhere|work from home|wfh|distributed|worldwide|global)\b/i;
export const REMOTE_TITLE_HINTS = /\b(remote|anywhere|wfh|work[- ]from[- ]home|distributed)\b/i;

function locationMatches(job: RawJob, target: string): boolean {
  const loc = (job.location ?? "").toLowerCase();
  if (!loc.trim()) return false;
  const targetLower = target.toLowerCase().trim();
  if (!targetLower) return false;
  // Tokenise the user-supplied location; AND-of-tokens substring check.
  // "remote" and "anywhere" are excluded so a target like "remote, UK"
  // is treated as a local match.
  const tokens = targetLower
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "remote" && t !== "anywhere");
  if (tokens.length === 0) return false;
  return tokens.every((tok) => loc.includes(tok));
}

function isRemoteCard(job: RawJob): boolean {
  const loc = (job.location ?? "").trim();
  if (REMOTE_LOC_HINTS.test(loc)) return true;
  if (REMOTE_TITLE_HINTS.test(job.title ?? "")) return true;
  return false;
}

export type RankedJobs = {
  local: RawJob[];   // location matches target
  remote: RawJob[];  // remote/anywhere tags
  other: RawJob[];   // everything else
};

export function rankByLocationRelevance(
  jobs: RawJob[],
  targetLocation: string | null | undefined,
): RankedJobs {
  if (!targetLocation || !targetLocation.trim()) {
    // No target — keep the input order; treat the whole list as "other".
    return { local: [], remote: [], other: jobs.slice() };
  }
  const local: RawJob[] = [];
  const remote: RawJob[] = [];
  const other: RawJob[] = [];
  for (const j of jobs) {
    if (locationMatches(j, targetLocation)) local.push(j);
    else if (isRemoteCard(j)) remote.push(j);
    else other.push(j);
  }
  return { local, remote, other };
}

// Re-export the underlying types so downstream callers (hunter.ts, route
// handlers) only need a single barrel import.
export type { RawJob, JobSource };
