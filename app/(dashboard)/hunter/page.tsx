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
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-secondary">
          <Search className="h-6 w-6 text-primary" /> Job Hunter
        </h1>
        <p className="mt-1 text-sm text-muted">
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
          className="flex-1 rounded-lg border border-secondary-300 bg-white px-4 py-3 text-sm shadow-sm placeholder:text-secondary-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-200"
          maxLength={500}
          disabled={pending}
        />
        <button
          type="submit"
          disabled={pending || !query.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
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
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-secondary-400">
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
                className="rounded-full border border-secondary-200 bg-white px-3 py-1.5 text-xs text-muted transition hover:border-primary-300 hover:bg-indigo-50 hover:text-primary-600"
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

      {/* Results */}
      {result && (
        <>
          {/* Reasoning banner */}
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-primary-100 bg-indigo-50/60 p-4">
            <Sparkles className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
            <div className="flex-1">
              <p className="text-sm text-muted">{result.reasoning}</p>
              <p className="mt-1 text-xs text-muted">
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
              className="inline-flex items-center gap-1 rounded-md border border-primary-200 bg-white px-2.5 py-1 text-xs font-medium text-primary-600 hover:bg-primary-100 disabled:opacity-50"
            >
              <RefreshCw className={clsx("h-3 w-3", pending && "animate-spin")} />
              Refresh
            </button>
          </div>

          {result.jobs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-secondary-300 bg-white p-12 text-center text-sm text-muted">
              No matches yet. Try broadening the role, location, or seniority.
            </div>
          ) : (
            <ul className="space-y-3">
              {result.jobs.map((job) => {
                const isOpen = expanded.has(job.id);
                const isSaved = savedIds.has(job.id);
                return (
                  <li
                    key={job.id}
                    className="rounded-xl border border-secondary-200 bg-white p-5 shadow-sm transition hover:border-primary-300"
                  >
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-secondary">
                            {job.title}
                          </h3>
                          <FitBadge score={job.fitScore} />
                          <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-muted">
                            {job.jobType}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
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
                          className="inline-flex items-center gap-1 rounded-md bg-secondary px-3 py-1.5 text-xs font-semibold text-white hover:bg-secondary-600"
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
                              : "border-secondary-200 bg-white text-muted hover:border-primary-300 hover:text-primary-600"
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
                      </div>
                    </div>

                    <p className="mt-3 text-sm text-muted">{job.snippet}</p>

                    <button
                      onClick={() => toggleExpand(job.id)}
                      className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-indigo-800"
                    >
                      {isOpen ? "Hide" : "Show"} reasoning
                      {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </button>

                    {isOpen && (
                      <div className="mt-3 rounded-lg bg-surface p-4 text-sm">
                        <p className="font-medium text-secondary-800">Why this fits your CV</p>
                        <p className="mt-1 text-muted">{job.fitReason}</p>
                        {job.matchHighlights.length > 0 && (
                          <>
                            <p className="mt-3 font-medium text-secondary-800">Matches</p>
                            <ul className="mt-1 list-inside list-disc space-y-0.5 text-muted">
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
                            <ul className="mt-1 list-inside list-disc space-y-0.5 text-muted">
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
