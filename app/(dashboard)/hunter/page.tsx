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
import { cn } from "@/lib/utils";

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

function fitBadgeClass(score: number) {
  if (score >= 75) {
    return "bg-primary-50 text-primary";
  }
  if (score >= 50) {
    return "bg-secondary-50 text-secondary";
  }
  return "bg-secondary-50 text-secondary-500";
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
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        fitBadgeClass(score),
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
   * Mark a job as "Applied" in the tracker. The tracker POST defaults
   * status to "applied" and seeds the history with the current timestamp,
   * and the (user_id, url) UNIQUE index makes a second click a no-op.
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
    <div className="container-wide space-y-8 py-10 md:py-14">
      <header>
        <h1 className="font-heading flex items-center gap-2 text-2xl font-bold tracking-tight md:text-3xl">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary-50 text-primary">
            <Search className="h-5 w-5" />
          </span>
          Job Hunter
        </h1>
        <p className="mt-1 text-sm text-secondary-500">
          Describe what you want. The agent searches the web, scores each role
          against your CV, and explains why it matches.
        </p>
      </header>

      {/* Search bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(false);
        }}
        className="rounded-2xl border border-secondary-100 bg-white p-2 shadow-card"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Find me ML internships in Dhaka open this month"
            className="flex-1 rounded-lg border border-secondary-100 bg-white px-4 py-3 text-sm text-secondary placeholder:text-secondary-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-50"
            maxLength={500}
            disabled={pending}
          />
          <button
            type="submit"
            disabled={pending || !query.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-white shadow-card transition hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
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
        </div>
      </form>

      {/* Sample chips */}
      {!result && !pending && (
        <section>
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-secondary-400">
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
                className="rounded-full border border-secondary-100 bg-white px-3.5 py-1.5 text-xs font-medium text-secondary-600 transition hover:border-primary hover:bg-primary-50 hover:text-primary"
              >
                {s}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Apply-to-tracker error (independent from the hunt error) */}
      {applyError && (
        <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>Couldn&apos;t add to tracker: {applyError}</span>
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          {/* Reasoning banner */}
          <section className="flex items-start gap-3 rounded-2xl border border-primary-100 bg-primary-50/50 p-4">
            <Sparkles className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
            <div className="flex-1">
              <p className="text-sm text-secondary">{result.reasoning}</p>
              <p className="mt-1 text-xs text-secondary-500">
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
              className="inline-flex items-center gap-1 rounded-md border border-primary-100 bg-white px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary-50 disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3 w-3", pending && "animate-spin")} />
              Refresh
            </button>
          </section>

          {result.jobs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-secondary-200 bg-white p-12 text-center text-sm text-secondary-500">
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
                    className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card transition hover:border-primary"
                  >
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <h3 className="font-heading text-base font-semibold text-secondary">
                            {job.title}
                          </h3>
                          <FitBadge score={job.fitScore} />
                          <span className="rounded-full bg-secondary-50 px-2 py-0.5 text-xs font-medium text-secondary-600">
                            {job.jobType}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-secondary-500">
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
                          className="inline-flex items-center gap-1 rounded-md bg-secondary px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-secondary-700"
                        >
                          Apply <ExternalLink className="h-3 w-3" />
                        </a>
                        <button
                          onClick={() => save(job)}
                          disabled={isSaved}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium transition",
                            isSaved
                              ? "border-primary-100 bg-primary-50 text-primary"
                              : "border-secondary-100 bg-white text-secondary-600 hover:border-primary hover:text-primary",
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
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold transition",
                            isApplied
                              ? "border-primary-100 bg-primary-50 text-primary"
                              : applyingId === job.id
                                ? "border-secondary-100 bg-secondary-50 text-secondary-400"
                                : "border-primary bg-primary text-white hover:bg-primary-600",
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

                    <p className="mt-3 text-sm text-secondary-600">{job.snippet}</p>
                    <button
                      onClick={() => toggleExpand(job.id)}
                      className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary-600"
                    >
                      {isOpen ? "Hide" : "Show"} reasoning
                      {isOpen ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>

                    {isOpen && (
                      <div className="mt-3 rounded-xl bg-secondary-50 p-4 text-sm">
                        <p className="font-medium text-secondary">
                          Why this fits your CV
                        </p>
                        <p className="mt-1 text-secondary-600">{job.fitReason}</p>
                        {job.matchHighlights.length > 0 && (
                          <>
                            <p className="mt-3 font-medium text-secondary">
                              Matches
                            </p>
                            <ul className="mt-1 list-inside list-disc space-y-0.5 text-secondary-600">
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
                            <ul className="mt-1 list-inside list-disc space-y-0.5 text-secondary-600">
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
