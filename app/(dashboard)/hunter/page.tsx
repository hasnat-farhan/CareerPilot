"use client";

import { useEffect, useRef, useState } from "react";
import {
  Search,
  Loader2,
  MapPin,
  Building2,
  Calendar,
  Banknote,
  ExternalLink,
  Sparkles,
  Bookmark,
  Check,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { clsx } from "clsx";

// ---------- types ----------

type JobCard = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  deadline: string | null;
  url: string;
  snippet: string;
  jobType: string;
  fitScore: number;
  fitReason: string;
  matchHighlights: string[];
  concerns: string[];
};

type HunterResponse = {
  query: string;
  jobs: JobCard[];
  reasoning: string;
  retrievedAt: string;
  cachedAt?: string;
  cached: boolean;
};

const SAMPLE_QUERIES = [
  "Find me ML internships in Dhaka open this month",
  "Remote React developer jobs paying over $80k",
  "Entry-level data science roles in London accepting new grads",
  "PhD research positions in computer vision, Europe",
];

// ---------- helpers ----------

function fitColor(score: number) {
  if (score >= 75) return "text-emerald-700 bg-emerald-50 ring-emerald-200";
  if (score >= 50) return "text-amber-700 bg-amber-50 ring-amber-200";
  return "text-rose-700 bg-rose-50 ring-rose-200";
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function FitBadge({ score }: { score: number }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1",
        fitColor(score)
      )}
      title={`Fit score ${score}/100`}
    >
      <Sparkles className="h-3 w-3" /> {score}% fit
    </span>
  );
}

// ---------- main component ----------

export default function HunterPage() {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<HunterResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function run(forceRefresh = false) {
    if (!query.trim()) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/hunt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), forceRefresh }),
      });
      const data: HunterResponse & { error?: string } = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        setResult(null);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setPending(false);
    }
  }

  async function save(job: JobCard) {
    try {
      const res = await fetch("/api/hunt/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job }),
      });
      if (res.ok) {
        setSavedIds((s) => new Set(s).add(job.id));
      }
    } catch {
      /* silent */
    }
  }

  /**
   * Mark a job as "Applied" in the tracker. This is the natural next step
   * after viewing a Hunter card: the user clicks Apply, opens the listing
   * in a new tab, then taps Mark Applied to log it on the Kanban board.
   *
   * The tracker POST defaults status to "applied" and seeds the history
   * with the current timestamp, so we don't need to know the application id
   * or do any follow-up. The (user_id, url) UNIQUE index makes a second
   * click a no-op — the API uses upsert semantics on the tracker side.
   */
  async function apply(job: JobCard) {
    if (appliedIds.has(job.id) || applyingId === job.id) return;
    setApplyError(null);
    setApplyingId(job.id);
    try {
      const res = await fetch("/api/tracker/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: job.company,
          role: job.title,
          url: job.url,
          location: job.location,
          salary: job.salary,
          deadline: job.deadline,
          notes: null,
        }),
      });
      if (res.ok) {
        setAppliedIds((s) => new Set(s).add(job.id));
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setApplyError(data.error ?? `Failed (HTTP ${res.status})`);
      }
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : "Network error");
    } finally {
      setApplyingId((cur) => (cur === job.id ? null : cur));
    }
  }

  function toggleExpand(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
          <Search className="h-6 w-6 text-indigo-600" /> Job Hunter
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Describe what you want. The agent searches the web, scores each role against your CV,
          and explains why it matches.
        </p>
      </header>

      {/* Search bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(false);
        }}
        className="mb-6 flex flex-col gap-2 sm:flex-row"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Find me ML internships in Dhaka open this month"
          className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          maxLength={500}
          disabled={pending}
        />
        <button
          type="submit"
          disabled={pending || !query.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Hunting…
            </>
          ) : (
            <>
              <Search className="h-4 w-4" /> Hunt
            </>
          )}
        </button>
      </form>

      {/* Sample chips */}
      {!result && !pending && (
        <div className="mb-8">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            Try one of these
          </p>
          <div className="flex flex-wrap gap-2">
            {SAMPLE_QUERIES.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setQuery(s);
                  setTimeout(() => run(false), 50);
                }}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Apply-to-tracker error (independent from the hunt error) */}
      {applyError && (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>Couldn&apos;t add to tracker: {applyError}</span>
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          {/* Reasoning banner */}
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
            <Sparkles className="mt-0.5 h-5 w-5 flex-shrink-0 text-indigo-600" />
            <div className="flex-1">
              <p className="text-sm text-slate-700">{result.reasoning}</p>
              <p className="mt-1 text-xs text-slate-500">
                {result.cached && result.cachedAt ? (
                  <>
                    <Clock className="mr-1 inline h-3 w-3" />
                    Cached · fetched {timeAgo(result.cachedAt)}
                  </>
                ) : (
                  <>Freshly fetched {timeAgo(result.retrievedAt)}</>
                )}
              </p>
            </div>
            <button
              onClick={() => run(true)}
              disabled={pending}
              className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-white px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
            >
              <RefreshCw className={clsx("h-3 w-3", pending && "animate-spin")} />
              Refresh
            </button>
          </div>

          {result.jobs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
              No matches yet. Try broadening the role, location, or seniority.
            </div>
          ) : (
            <ul className="space-y-3">
              {result.jobs.map((job) => {
                const isOpen = expanded.has(job.id);
                const isSaved = savedIds.has(job.id);
                const isApplied = appliedIds.has(job.id);
                return (
                  <li
                    key={job.id}
                    className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300"
                  >
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-slate-900">
                            {job.title}
                          </h3>
                          <FitBadge score={job.fitScore} />
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                            {job.jobType}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
                          <span className="inline-flex items-center gap-1">
                            <Building2 className="h-3.5 w-3.5" /> {job.company}
                          </span>
                          {job.location && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5" /> {job.location}
                            </span>
                          )}
                          {job.salary && (
                            <span className="inline-flex items-center gap-1">
                              <Banknote className="h-3.5 w-3.5" /> {job.salary}
                            </span>
                          )}
                          {job.deadline && (
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="h-3.5 w-3.5" /> {job.deadline}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <a
                          href={job.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
                        >
                          Apply <ExternalLink className="h-3 w-3" />
                        </a>
                        <button
                          onClick={() => save(job)}
                          disabled={isSaved}
                          className={clsx(
                            "inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium transition",
                            isSaved
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
                          )}
                        >
                          {isSaved ? (
                            <>
                              <Check className="h-3 w-3" /> Saved
                            </>
                          ) : (
                            <>
                              <Bookmark className="h-3 w-3" /> Save
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => apply(job)}
                          disabled={isApplied || applyingId === job.id}
                          aria-pressed={isApplied}
                          title={
                            isApplied
                              ? "Added to your tracker (Applied column)"
                              : "Mark as applied and add to the tracker"
                          }
                          className={clsx(
                            "inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold transition",
                            isApplied
                              ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                              : applyingId === job.id
                                ? "border-slate-200 bg-slate-50 text-slate-400"
                                : "border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700"
                          )}
                        >
                          {isApplied ? (
                            <>
                              <CheckCircle2 className="h-3 w-3" /> Applied
                            </>
                          ) : applyingId === job.id ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin" /> Marking…
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="h-3 w-3" /> Mark applied
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    <p className="mt-3 text-sm text-slate-600">{job.snippet}</p>

                    <button
                      onClick={() => toggleExpand(job.id)}
                      className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                    >
                      {isOpen ? "Hide" : "Show"} reasoning
                      {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </button>

                    {isOpen && (
                      <div className="mt-3 rounded-lg bg-slate-50 p-4 text-sm">
                        <p className="font-medium text-slate-800">Why this fits your CV</p>
                        <p className="mt-1 text-slate-700">{job.fitReason}</p>
                        {job.matchHighlights.length > 0 && (
                          <>
                            <p className="mt-3 font-medium text-slate-800">Matches</p>
                            <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-600">
                              {job.matchHighlights.map((h, i) => (
                                <li key={i}>{h}</li>
                              ))}
                            </ul>
                          </>
                        )}
                        {job.concerns.length > 0 && (
                          <>
                            <p className="mt-3 flex items-center gap-1 font-medium text-amber-700">
                              <AlertTriangle className="h-3.5 w-3.5" /> Concerns
                            </p>
                            <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-600">
                              {job.concerns.map((c, i) => (
                                <li key={i}>{c}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
