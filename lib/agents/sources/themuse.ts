// The Muse — curated tech / startup listings.
// Docs: https://www.themuse.com/developers/api/v2
// Public endpoint, no auth required (rate-limited to 500/day).
// If THEME_MUSE_API_KEY is set, lifts the limit to 5000/day.

import type { JobSource, RawJob, JobType } from "./types";

const API_URL = "https://www.themuse.com/api/public/jobs";

type MuseJob = {
  id: number;
  name: string;               // title
  contents: string;           // HTML description
  publication_date: string;   // ISO
  location: string;           // human-readable
  categories: { name: string }[];
  company: { id: number; name: string };
  refs?: { landing_page: string };
  levels?: { name: string; short_name: string }[];
};

type MuseResponse = {
  results: MuseJob[];
  page_count: number;
};

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

function jobTypeFrom(levels: MuseJob["levels"]): JobType {
  const names = (levels ?? []).map((l) => l.short_name.toLowerCase());
  if (names.includes("internship")) return "internship";
  if (names.includes("contract") || names.includes("freelance")) return "contract";
  if (names.includes("part time")) return "part-time";
  return "full-time";
}

export const themuseSource: JobSource = {
  name: "themuse",
  async search(query) {
    try {
      const params = new URLSearchParams();
      params.set("page", "0");
      params.set("descending", "true");
      // The Muse uses category slugs for structured search; for free-text
      // we put the query in `category` and Muse still does keyword matching
      // against title + company + content.
      if (query.trim()) params.set("category", query.trim());

      const headers: Record<string, string> = {
        "User-Agent": "CareerPilot/1.0",
        Accept: "application/json",
      };
      if (process.env.THEMUSE_API_KEY) {
        headers["Authorization"] = `Bearer ${process.env.THEMUSE_API_KEY}`;
      }

      const res = await fetch(`${API_URL}?${params.toString()}`, { headers });
      if (!res.ok) {
        console.warn(`[themuse] fetch failed: ${res.status}`);
        return [];
      }
      const json = (await res.json()) as MuseResponse;
      const data = Array.isArray(json.results) ? json.results : [];
      return data.slice(0, 15).map<RawJob>((p) => ({
        source: "themuse",
        externalId: String(p.id),
        title: p.name,
        company: p.company?.name ?? "Unknown",
        location: p.location,
        salary: null,
        deadline: null,
        url:
          p.refs?.landing_page ??
          `https://www.themuse.com/jobs/${p.company?.id}/${p.id}`,
        snippet: stripHtml(p.contents).slice(0, 600),
        jobType: jobTypeFrom(p.levels),
        postedAt: p.publication_date ?? null,
      }));
    } catch (err) {
      console.warn("[themuse] search failed:", (err as Error).message);
      return [];
    }
  },
};
