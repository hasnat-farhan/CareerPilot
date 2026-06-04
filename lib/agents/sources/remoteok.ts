// RemoteOK — open JSON feed, no auth, no rate limit (cache 5 min).
// Docs: https://remoteok.com/api
//
// We can't query a real search endpoint, so we pull the full feed once
// and filter client-side. The feed is ~1.5k active remote postings.

import type { JobSource, RawJob, JobType } from "./types";

const FEED_URL = "https://remoteok.com/api?tags=&action=getList";

type RemoteOkPosting = {
  id: string;
  url: string;
  position: string;
  company: string;
  company_logo?: string;
  location?: string;
  tags?: string[];
  description?: string;     // HTML
  salary_min?: number;
  salary_max?: number;
  date?: string;            // ISO
  [k: string]: unknown;
};

const TEXT_CACHE: { at: number; data: RemoteOkPosting[] } = { at: 0, data: [] };
const CACHE_MS = 5 * 60 * 1000;

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function jobTypeFrom(tags: string[] | undefined): JobType {
  const t = (tags ?? []).map((s) => s.toLowerCase());
  if (t.some((x) => x.includes("intern"))) return "internship";
  if (t.some((x) => x.includes("contract") || x.includes("freelance"))) return "contract";
  if (t.some((x) => x.includes("part") || x.includes("part-time"))) return "part-time";
  return "full-time";
}

async function loadFeed(): Promise<RemoteOkPosting[]> {
  const now = Date.now();
  if (TEXT_CACHE.data.length && now - TEXT_CACHE.at < CACHE_MS) {
    return TEXT_CACHE.data;
  }
  const res = await fetch(FEED_URL, {
    headers: {
      "User-Agent": "CareerPilot/1.0 (https://careerpilot.app)",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    console.warn(`[remoteok] feed fetch failed: ${res.status}`);
    return TEXT_CACHE.data; // fall back to stale if we have it
  }
  const json = (await res.json()) as RemoteOkPosting[];
  // First entry is often a legal/privacy notice object — drop anything without an `id`.
  TEXT_CACHE.data = Array.isArray(json) ? json.filter((p) => p?.id) : [];
  TEXT_CACHE.at = now;
  return TEXT_CACHE.data;
}

function scoreMatch(p: RemoteOkPosting, query: string): number {
  const q = query.toLowerCase();
  const haystack = [
    p.position,
    p.company,
    p.location ?? "",
    ...(p.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  if (!q.trim()) return 1;
  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return 1;
  let score = 0;
  for (const t of terms) {
    if (haystack.includes(t)) score += 1;
  }
  return score / terms.length;
}

export const remoteokSource: JobSource = {
  name: "remoteok",
  async search(query) {
    try {
      const feed = await loadFeed();
      const ranked = feed
        .map((p) => ({ p, s: scoreMatch(p, query) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 15);

      const out: RawJob[] = ranked.map(({ p }) => ({
        source: "remoteok",
        externalId: String(p.id),
        title: p.position,
        company: p.company ?? "Unknown",
        location: p.location?.trim() || "Remote",
        salary:
          p.salary_min && p.salary_max
            ? `$${Math.round(p.salary_min / 1000)}k–$${Math.round(p.salary_max / 1000)}k`
            : null,
        deadline: null,
        url: p.url ?? `https://remoteok.com/remote-jobs/${p.id}`,
        snippet: stripHtml((p.description ?? "").slice(0, 600)),
        jobType: jobTypeFrom(p.tags),
        postedAt: p.date ?? null,
      }));
      return out;
    } catch (err) {
      console.warn("[remoteok] search failed:", (err as Error).message);
      return [];
    }
  },
};
