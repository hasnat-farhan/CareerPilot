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
  BookmarkCheck,
  Check,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Globe,
  Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------- types ----------

type FitScoreBreakdown = {
  /** 0..1 — skill overlap component. */
  skillOverlap: number;
  /** 0..1 — semantic similarity between CV and JD. */
  semantic: number;
  /** 0..1 — experience / education match. */
  experience: number;
};

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
  /** Same shape as FitScoreResult.breakdown — 0..1 components used to
   *  derive the headline fitScore via the 60/30/10 formula. Optional so
   *  older saved cards without a stored breakdown still render. */
  breakdown?: FitScoreBreakdown | null;
  /** Stamped by the hunter agent when the card was surfaced by the
   *  remote-fallback branch. Optional. */
  isRemoteFallback?: boolean;
  /** Source the job came from (RemoteOK, Arbeitnow, etc). Optional. */
  source?: string | null;
  /** ISO timestamp the user bookmarked this job. Only present on cards
   *  loaded from /api/hunt/save (the Saved tab). */
  savedAt?: string;
  /** True when the saved card's CV snapshot is older than the user's
   *  current CV — the GET endpoint re-scored it via the deterministic
   *  engine and persisted fresh values. */
  stale?: boolean;
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

/**
 * Tiny segmented bar that visualises the three fit-score components.
 * Shown beneath the headline score so the user can see WHY the agent
 * ranked the job where it did. Tooltip exposes the raw 0..1 floats.
 */
function BreakdownBar({
  breakdown,
  onClick,
}: {
  breakdown: FitScoreBreakdown;
  onClick?: () => void;
}) {
  const pct = (n: number) => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group mt-2 block w-full text-left"
      title={`Skills ${pct(breakdown.skillOverlap)} · Semantic ${pct(breakdown.semantic)} · Experience ${pct(breakdown.experience)}`}
    >
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-secondary-100">
        <span
          className="bg-primary"
          style={{ width: pct(breakdown.skillOverlap) }}
        />
        <span
          className="bg-primary-300"
          style={{ width: pct(breakdown.semantic) }}
        />
        <span
          className="bg-primary-100"
          style={{ width: pct(breakdown.experience) }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] font-medium text-secondary-400">
        <span>Skills {pct(breakdown.skillOverlap)}</span>
        <span>Semantic {pct(breakdown.semantic)}</span>
        <span>Experience {pct(breakdown.experience)}</span>
      </div>
    </button>
  );
}

/**
 * Shared JobCard renderer. Used by both the Search and Saved tabs so
 * the saved bookmark looks and behaves identically to a live hunt card.
 *
 * Behaviour is parameterised by `variant`:
 *   - "search": shows the bookmark toggle (Save / Saved).
 *   - "saved":  shows an Unsave button + optional stale re-score hint.
 */
type CardVariant = "search" | "saved";

function HunterCard({
  job,
  variant,
  isExpanded,
  isSaved,
  isApplied,
  isPendingApply,
  isUnsaveInFlight,
  onToggleExpand,
  onSave,
  onUnsave,
  onApply,
}: {
  job: JobCard;
  variant: CardVariant;
  isExpanded: boolean;
  isSaved: boolean;
  isApplied: boolean;
  isPendingApply: boolean;
  isUnsaveInFlight: boolean;
  onToggleExpand: () => void;
  onSave: () => void;
  onUnsave: () => void;
  onApply: () => void;
}) {
  return (
    <li
      className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card transition hover:border-primary"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-base font-semibold text-secondary">
              {job.title}
            </h3>
            <FitBadge score={job.fitScore} />
            {job.isRemoteFallback && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700"
                title="No roles in your location this week — surfacing remote matches."
              >
                <Globe className="h-3 w-3" /> Remote fallback
              </span>
            )}
            {job.stale && variant === "saved" && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
                title="Your CV has changed since this was saved — the score above was just re-computed."
              >
                <RefreshCw className="h-3 w-3" /> Re-scored
              </span>
            )}
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
            {job.source && (
              <span className="inline-flex items-center gap-1 text-xs text-secondary-400">
                via {job.source}
              </span>
            )}
          </div>
          {job.breakdown && (
            <BreakdownBar breakdown={job.breakdown} onClick={onToggleExpand} />
          )}
          {variant === "saved" && job.savedAt && (
            <p className="mt-1 text-[11px] text-secondary-400">
              Saved {timeAgo(job.savedAt)}
            </p>
          )}
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
          {variant === "search" ? (
            <button
              onClick={onSave}
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
          ) : (
            <button
              onClick={onUnsave}
              disabled={isUnsaveInFlight}
              className="inline-flex items-center gap-1 rounded-md border border-secondary-100 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:border-rose-200 hover:bg-rose-50 disabled:opacity-50"
            >
              {isUnsaveInFlight ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Removing…
                </>
              ) : (
                <>
                  <BookmarkCheck className="h-3 w-3" /> Saved · Unsave
                </>
              )}
            </button>
          )}
          <button
            onClick={onApply}
            disabled={isApplied || isPendingApply}
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
                : isPendingApply
                  ? "border-secondary-100 bg-secondary-50 text-secondary-400"
                  : "border-primary bg-primary text-white hover:bg-primary-600",
            )}
          >
            {isApplied ? (
              <>
                <CheckCircle2 className="h-3 w-3" /> Applied
              </>
            ) : isPendingApply ? (
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
        onClick={onToggleExpand}
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary-600"
      >
        {isExpanded ? "Hide" : "Show"} reasoning
        {isExpanded ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
      </button>

      {isExpanded && (
        <div className="mt-3 rounded-xl bg-secondary-50 p-4 text-sm">
          <p className="font-medium text-secondary">Why this fits your CV</p>
          <p className="mt-1 text-secondary-600">{job.fitReason}</p>
          {job.matchHighlights.length > 0 && (
            <>
              <p className="mt-3 font-medium text-secondary">Matches</p>
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

  // ----- Saved Jobs tab state -----
  //
  // The page has two top-level modes:
  //   - "search": the live hunter — query + results + the search bar.
  //   - "saved":  the user's bookmarked cards, loaded from /api/hunt/save.
  //
  // We lazy-load the saved list the first time the user switches to the
  // Saved tab (and any subsequent re-entry, so newly-saved cards show up
  // without a full page reload). If the API reports any `stale` cards
  // (i.e. the user's CV has been updated since the card was saved) we
  // auto-pass `?recompute=1` so the deterministic engine re-scores
  // them on read and persists the fresh values back to hunter_saved.
  type Mode = "search" | "saved";
  const [mode, setMode] = useState<Mode>("search");
  const [savedJobs, setSavedJobs] = useState<JobCard[]>([]);
  const [savedLoaded, setSavedLoaded] = useState(false);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [unsavingId, setUnsavingId] = useState<string | null>(null);
  const [savedRevision, setSavedRevision] = useState(0); // bumps to force reload
  // True only when the user clicked the in-tab "Refresh" button. The
  // first load (mount + mode change) leaves this false so the Saved
  // tab jumps straight to the empty / list view instead of flashing a
  // skeleton for a beat — most users opening this tab for the first
  // time have zero bookmarks, and the skeleton was reading as "there
  // are jobs but they're loading".
  const [savedRefreshing, setSavedRefreshing] = useState(false);

  // Keep savedIds in sync with the loaded saved list so the Save button
  // shows "Saved" on cards the user has already bookmarked in a prior
  // session. We do this on load + whenever the user bookmarks/un-bookmarks.
  useEffect(() => {
    if (!savedLoaded) return;
    setSavedIds((prev) => {
      const next = new Set(prev);
      for (const j of savedJobs) next.add(j.id);
      return next;
    });
  }, [savedLoaded, savedJobs]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Lazy-load the saved list when the user enters the Saved tab. We
  // also reload when `savedRevision` is bumped (after a successful save
  // from the Search tab) so the Saved view shows cards the user
  // bookmarked moments ago without a manual refresh.
  useEffect(() => {
    if (mode !== "saved") return;
    loadSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, savedRevision]);

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
        // Bump the revision so the Saved tab reloads on next entry. We
        // don't reload inline (would force an extra round trip while
        // the user is still in Search mode).
        setSavedRevision((r) => r + 1);
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

  /**
   * Load the user's bookmarked jobs from /api/hunt/save. Called when the
   * user enters the Saved tab and any time we want to refresh the list
   * (e.g. after a save/unsave in another tab mode). When the API
   * reports any `stale` cards we re-issue the request with
   * `?recompute=1` so the deterministic engine refreshes them against
   * the user's current CV.
   */
  async function loadSaved() {
    setSavedLoading(true);
    setSavedError(null);
    // We don't set savedRefreshing=true here — only the Refresh button
    // does. The skeleton is reserved for explicit refreshes, so the
    // first time the user opens this tab it goes straight to the
    // empty state when they have zero bookmarks.
    try {
      // First pass: no recompute (fast). Inspect stale flags.
      const first = await fetch("/api/hunt/save", { method: "GET" });
      if (!first.ok) {
        const data = (await first.json().catch(() => ({}))) as { error?: string };
        setSavedError(data.error ?? `Failed (HTTP ${first.status})`);
        setSavedJobs([]);
        return;
      }
      const firstData = (await first.json()) as { jobs: JobCard[] };
      const hasStale = (firstData.jobs ?? []).some((j) => j.stale);
      if (!hasStale) {
        setSavedJobs(firstData.jobs ?? []);
        return;
      }
      // Second pass: re-score stale cards via the deterministic engine
      // and persist the fresh values. The response is authoritative.
      const second = await fetch("/api/hunt/save?recompute=1", { method: "GET" });
      if (!second.ok) {
        // Fall back to the stale snapshot — better than blanking the UI.
        setSavedJobs(firstData.jobs ?? []);
        return;
      }
      const secondData = (await second.json()) as { jobs: JobCard[] };
      setSavedJobs(secondData.jobs ?? []);
    } catch (e) {
      setSavedError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSavedLoading(false);
      setSavedLoaded(true);
      setSavedRefreshing(false);
    }
  }

  /**
   * Un-bookmark a card by URL. Removes it from hunter_saved and from
   * the local saved list so the Saved tab updates immediately. The
   * `savedIds` set is also cleared so the Save button in the Search
   * tab reverts to its unbookmarked state.
   */
  async function unsave(job: JobCard) {
    if (unsavingId === job.id) return;
    setUnsavingId(job.id);
    try {
      const res = await fetch("/api/hunt/save", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: job.url }),
      });
      if (res.ok) {
        setSavedJobs((cur) => cur.filter((j) => j.url !== job.url));
        setSavedIds((cur) => {
          const n = new Set(cur);
          n.delete(job.id);
          return n;
        });
      }
    } catch {
      /* silent */
    } finally {
      setUnsavingId((cur) => (cur === job.id ? null : cur));
    }
  }

  return (
    <div className="container-wide space-y-8 py-10 md:py-14">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading flex items-center gap-2 text-2xl font-bold tracking-tight md:text-3xl">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary-50 text-primary">
              <Search className="h-5 w-5" />
            </span>
            Job Hunter
          </h1>
          <p className="mt-1 text-sm text-secondary-500">
            {mode === "search"
              ? "Describe what you want. The agent searches the web, scores each role against your CV, and explains why it matches."
              : "Your bookmarked jobs. Cards whose CV is out of date are re-scored using the same Fit Score engine when you open this tab."}
          </p>
        </div>
        {/* Search | Saved toggle. Lives next to the title so it persists
            regardless of which mode is active. The Saved badge shows the
            current count so the user knows there's something to look at
            before they switch tabs. */}
        <div
          role="tablist"
          aria-label="Hunter view"
          className="inline-flex rounded-lg border border-secondary-100 bg-white p-0.5 shadow-sm"
        >
          <button
            role="tab"
            aria-selected={mode === "search"}
            onClick={() => setMode("search")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition",
              mode === "search"
                ? "bg-primary text-white shadow-sm"
                : "text-secondary-600 hover:text-secondary",
            )}
          >
            <Search className="h-3.5 w-3.5" /> Search
          </button>
          <button
            role="tab"
            aria-selected={mode === "saved"}
            onClick={() => setMode("saved")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition",
              mode === "saved"
                ? "bg-primary text-white shadow-sm"
                : "text-secondary-600 hover:text-secondary",
            )}
          >
            <BookmarkCheck className="h-3.5 w-3.5" /> Saved
            {savedIds.size > 0 && mode !== "saved" && (
              <span
                className={cn(
                  "ml-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[10px] font-bold",
                  mode === "search"
                    ? "bg-white/20 text-white"
                    : "bg-primary-50 text-primary",
                )}
                aria-label={`${savedIds.size} saved jobs`}
              >
                {savedIds.size}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* ---------- Search tab body ---------- */}
      {mode === "search" && (
        <>
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
                  {result.jobs.map((job) => (
                    <HunterCard
                      key={job.id}
                      job={job}
                      variant="search"
                      isExpanded={expanded.has(job.id)}
                      isSaved={savedIds.has(job.id)}
                      isApplied={appliedIds.has(job.id)}
                      isPendingApply={applyingId === job.id}
                      isUnsaveInFlight={false}
                      onToggleExpand={() => toggleExpand(job.id)}
                      onSave={() => save(job)}
                      onUnsave={() => unsave(job)}
                      onApply={() => apply(job)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}

      {/* ---------- Saved tab body ---------- */}
      {mode === "saved" && (
        <>
          {/* Loading skeleton — only on explicit refresh. First mount
              skips this so users with zero bookmarks go straight to
              the "No saved jobs yet" empty state. */}
          {savedRefreshing && (
            <ul className="space-y-3">
              {[0, 1, 2].map((i) => (
                <li
                  key={i}
                  className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card"
                >
                  <div className="flex flex-col gap-3">
                    <div className="h-5 w-1/2 animate-pulse rounded bg-secondary-100" />
                    <div className="h-3 w-1/3 animate-pulse rounded bg-secondary-100" />
                    <div className="h-3 w-full animate-pulse rounded bg-secondary-100" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Error */}
          {savedError && !savedRefreshing && (
            <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{savedError}</span>
            </div>
          )}

          {/* Empty state — fires whenever we know the user has zero
              bookmarks, including during the in-flight period on
              first mount. We never block this on `savedLoaded` so
              the tab never shows a blank gap before the API
              responds. */}
          {!savedError && !savedRefreshing && savedJobs.length === 0 && (
            <div className="rounded-2xl border border-dashed border-secondary-200 bg-white p-12 text-center">
              <Inbox className="mx-auto mb-3 h-10 w-10 text-secondary-300" />
              <p className="font-heading text-base font-semibold text-secondary">
                No saved jobs yet
              </p>
              <p className="mt-1 text-sm text-secondary-500">
                Bookmark roles from the Search tab and they&apos;ll show up here,
                ready to revisit with fresh scores whenever your CV changes.
              </p>
              <button
                onClick={() => setMode("search")}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-primary bg-white px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary-50"
              >
                <Search className="h-3.5 w-3.5" /> Start a hunt
              </button>
            </div>
          )}

          {/* Saved cards */}
          {!savedError && !savedRefreshing && savedJobs.length > 0 && (
            <>
              <section className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-primary-100 bg-primary-50/50 p-3 text-xs text-secondary-600">
                <p>
                  <BookmarkCheck className="mr-1 inline h-3.5 w-3.5 text-primary" />
                  {savedJobs.length} saved job
                  {savedJobs.length === 1 ? "" : "s"}. Cards marked{" "}
                  <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                    Re-scored
                  </span>{" "}
                  were refreshed against your current CV.
                </p>
                <button
                  onClick={() => {
                    setSavedLoaded(false);
                    setSavedRefreshing(true);
                    loadSaved();
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-primary-100 bg-white px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary-50"
                >
                  <RefreshCw className="h-3 w-3" /> Refresh
                </button>
              </section>
              <ul className="space-y-3">
                {savedJobs.map((job) => (
                  <HunterCard
                    key={job.id}
                    job={job}
                    variant="saved"
                    isExpanded={expanded.has(job.id)}
                    isSaved
                    isApplied={appliedIds.has(job.id)}
                    isPendingApply={applyingId === job.id}
                    isUnsaveInFlight={unsavingId === job.id}
                    onToggleExpand={() => toggleExpand(job.id)}
                    onSave={() => save(job)}
                    onUnsave={() => unsave(job)}
                    onApply={() => apply(job)}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
