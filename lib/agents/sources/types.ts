// Shared types for every job-board source the agent can talk to.
//
// Each source implements JobSource.search() and returns RawJob[] in this
// exact shape. The hunter agent then dedupes, scores with Gemini, and
// surfaces the result to the UI as JobCard[] (defined in hunter.ts).

export type JobType = "internship" | "full-time" | "contract" | "research" | "part-time" | "other";

export type RawJob = {
  source: string;            // "remoteok" | "arbeitnow" | "themuse" | "adzuna"
  externalId: string;        // id from the source, for stable keys
  title: string;
  company: string;
  location: string | null;   // human-readable, may be "Remote" or "London, UK"
  salary: string | null;     // human-readable, may be "£60k-£80k" or null
  deadline: string | null;   // ISO yyyy-mm-dd, null if unknown
  url: string;               // canonical link to the posting
  snippet: string;           // 1-3 sentence teaser
  jobType: JobType;
  postedAt: string | null;   // ISO timestamp from the source
};

export interface JobSource {
  name: string;
  /**
   * Search for jobs matching the given query.
   * Implementations should never throw — return [] on error and log instead,
   * so one broken source doesn't kill the fan-out.
   */
  search(query: string, opts?: { location?: string; page?: number; rawQuery?: string }): Promise<RawJob[]>;
}

/** A single Open Source / no-key source descriptor used by the source registry. */
export type SourceName = "remoteok" | "arbeitnow" | "themuse" | "adzuna";
