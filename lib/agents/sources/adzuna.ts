// Adzuna — global job-board aggregator. Normalised salary min/max and
// posted dates make it the highest-quality structured source we have.
// Docs: https://developer.adzuna.com/docs/search
//
// Auth: requires Adzuna_API_ID (a.k.a. app_id) and Adzuna_API_KEY.
// We support country code as part of the location string ("UK", "US", etc.)
// — if you don't pass one we default to "gb" since the keys are GB-issued.

import type { JobSource, RawJob, JobType } from "./types";

const COUNTRIES = ["gb", "us", "au", "at", "be", "br", "ca", "ch", "de", "es", "fr", "in", "it", "mx", "nl", "nz", "pl", "sg", "za"] as const;
type Country = (typeof COUNTRIES)[number];

type AdzunaResult = {
  id: string;
  title: string;
  company: { display_name: string };
  location: { display_name: string; area?: string[] };
  salary_min?: number | null;
  salary_max?: number | null;
  created: string;            // ISO
  description: string;        // plain text
  redirect_url: string;
  contract_type?: string | null;   // "full_time", "part_time", "contract", "internship"
  contract_time?: string | null;    // "full_time", "part_time"
};

type AdzunaResponse = {
  results: AdzunaResult[];
  count: number;
};

function buildCountry(opts?: { location?: string }): Country {
  const loc = (opts?.location ?? "").toLowerCase();
  if (!loc) return "gb";
  // 1. try explicit country code at end: "dhaka, bd" → "bd"
  const tail = loc.split(/[,\s]+/).pop() ?? "";
  if ((COUNTRIES as readonly string[]).includes(tail)) return tail as Country;
  // 2. try a few common aliases
  const aliases: Record<string, Country> = {
    uk: "gb",
    england: "gb",
    "united kingdom": "gb",
    america: "us",
    "united states": "us",
    "u.s.": "us",
    bangladesh: "gb", // no BD in adzuna, fall back
    london: "gb",
    dhaka: "gb",
  };
  for (const [k, v] of Object.entries(aliases)) {
    if (loc.includes(k)) return v;
  }
  return "gb";
}

function jobTypeFromAdzuna(r: AdzunaResult): JobType {
  const t = [r.contract_type, r.contract_time]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (t.includes("intern")) return "internship";
  if (t.includes("contract") || t.includes("freelance")) return "contract";
  if (t.includes("part")) return "part-time";
  return "full-time";
}

function formatSalary(r: AdzunaResult, country: Country): string | null {
  if (!r.salary_min && !r.salary_max) return null;
  const sym = country === "gb" ? "£" : country === "us" ? "$" : "";
  const fmt = (n: number) => {
    if (n >= 1000) return `${sym}${Math.round(n / 1000)}k`;
    return `${sym}${n}`;
  };
  if (r.salary_min && r.salary_max) return `${fmt(r.salary_min)}–${fmt(r.salary_max)}`;
  if (r.salary_min) return `from ${fmt(r.salary_min)}`;
  if (r.salary_max) return `up to ${fmt(r.salary_max)}`;
  return null;
}

function stripSnippet(s: string): string {
  // Adzuna hands us the full job description. We just want a teaser.
  // Flatten to single line so the value can never break a JSON string
  // when the LLM echoes it back into its structured response.
  return s
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

export const adzunaSource: JobSource = {
  name: "adzuna",
  async search(query, opts) {
    const appId = process.env.Adzuna_API_ID;
    const appKey = process.env.Adzuna_API_KEY;
    if (!appId || !appKey) {
      console.warn("[adzuna] missing Adzuna_API_ID or Adzuna_API_KEY — skipping");
      return [];
    }
    const country = buildCountry(opts);
    try {
      const url = new URL(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/1`
      );
      url.searchParams.set("app_id", appId);
      url.searchParams.set("app_key", appKey);
      url.searchParams.set("results_per_page", "20");
      url.searchParams.set("what", query);
      // Adzuna wants "where" as a free-text location, not a country code.
      if (opts?.location) url.searchParams.set("where", opts.location);
      url.searchParams.set("content-type", "application/json");

      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        console.warn(`[adzuna] fetch failed: ${res.status}`);
        return [];
      }
      const json = (await res.json()) as AdzunaResponse;
      const data = Array.isArray(json.results) ? json.results : [];
      return data.slice(0, 15).map<RawJob>((p) => ({
        source: "adzuna",
        externalId: String(p.id),
        title: p.title,
        company: p.company?.display_name ?? "Unknown",
        location: p.location?.display_name ?? null,
        salary: formatSalary(p, country),
        deadline: null, // Adzuna doesn't expose a deadline
        url: p.redirect_url,
        snippet: stripSnippet(p.description),
        jobType: jobTypeFromAdzuna(p),
        postedAt: p.created ?? null,
      }));
    } catch (err) {
      console.warn("[adzuna] search failed:", (err as Error).message);
      return [];
    }
  },
};
