// Arbeitnow — open JSON API, no auth, EU-leaning tech jobs.
// Docs: https://arbeitnow.com/api

import type { JobSource, RawJob, JobType } from "./types";

const API_URL = "https://www.arbeitnow.com/api/job-board-api";

type ArbeitnowPosting = {
  slug: string;
  id: string | number;
  company_name: string;
  title: string;
  description: string;        // plain text
  remote: boolean;
  url: string;
  tags?: string[];
  job_types?: string[];       // e.g. ["full-time"], ["internship"]
  location?: string;
  created_at: number;         // unix seconds
};

type ArbeitnowResponse = {
  data: ArbeitnowPosting[];
  links?: { next?: string | null };
  meta?: { currentPage?: number };
};

function jobTypeFrom(jobTypes: string[] | undefined, remote: boolean): JobType {
  const t = (jobTypes ?? []).map((s) => s.toLowerCase());
  if (t.some((x) => x.includes("intern"))) return "internship";
  if (t.some((x) => x.includes("contract") || x.includes("freelance"))) return "contract";
  if (t.some((x) => x.includes("part"))) return "part-time";
  // Arbeitnow doesn't differentiate "research"; fall through.
  void remote; // reserved for future heuristic
  return "full-time";
}

function stripSnippet(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 600);
}

export const arbeitnowSource: JobSource = {
  name: "arbeitnow",
  async search(query) {
    try {
      const url = `${API_URL}?search=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "CareerPilot/1.0",
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        console.warn(`[arbeitnow] fetch failed: ${res.status}`);
        return [];
      }
      const json = (await res.json()) as ArbeitnowResponse;
      const data = Array.isArray(json.data) ? json.data : [];
      return data.slice(0, 15).map<RawJob>((p) => ({
        source: "arbeitnow",
        externalId: String(p.id ?? p.slug),
        title: p.title,
        company: p.company_name,
        location: p.location ?? (p.remote ? "Remote" : null),
        salary: null,
        deadline: null,
        url: p.url,
        snippet: stripSnippet(p.description),
        jobType: jobTypeFrom(p.job_types, p.remote),
        postedAt: p.created_at ? new Date(p.created_at * 1000).toISOString() : null,
      }));
    } catch (err) {
      console.warn("[arbeitnow] search failed:", (err as Error).message);
      return [];
    }
  },
};
