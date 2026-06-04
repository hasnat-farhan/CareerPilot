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
