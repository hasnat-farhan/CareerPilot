"use client";

import { useState } from "react";
import { clsx } from "clsx";
import Link from "next/link";
import {
  Gauge as GaugeIcon,
  Loader2,
  CheckCircle2,
  XCircle,
  Sparkles,
  ArrowRight,
  AlertCircle,
  UploadCloud,
} from "lucide-react";

// ---------- types (mirror lib/agents/fitScore.ts) ----------

type Skill = {
  id: string;
  label: string;
  category?: string;
  weight?: number;
};

type ScoredSkill = { skill: Skill; matched: boolean };

type FitScoreResult = {
  score: number;
  verdict: "strong" | "good" | "borderline" | "weak";
  matched: ScoredSkill[];
  missing: ScoredSkill[];
  niceToHaveMatched: ScoredSkill[];
  experience: {
    inferredYears: number;
    requiredYears: number;
    inferredEducation: string;
    requiredEducation: string;
    yearsDelta: number;
  };
  rationale: string;
  benchmarkUsed: string;
  computedAt: string;
};

const VERDICT_LABEL: Record<FitScoreResult["verdict"], string> = {
  strong: "Strong match",
  good: "Good match",
  borderline: "Borderline",
  weak: "Weak match",
};

const VERDICT_BLURB: Record<FitScoreResult["verdict"], string> = {
  strong: "You're a credible candidate. Apply with confidence.",
  good: "Worth applying — sharpen a couple of the gap items in your CV first.",
  borderline: "Reach out to a referral before applying. Bridge the top gap.",
  weak: "Build 2–3 of the must-haves before applying — typically a 2–4 week sprint.",
};

function verdictColor(v: FitScoreResult["verdict"]): string {
  switch (v) {
    case "strong":
      return "text-emerald-700 bg-emerald-50 ring-emerald-200";
    case "good":
      return "text-sky-700 bg-sky-50 ring-sky-200";
    case "borderline":
      return "text-amber-700 bg-amber-50 ring-amber-200";
    case "weak":
      return "text-rose-700 bg-rose-50 ring-rose-200";
  }
}

function scoreRingColor(score: number): string {
  if (score >= 80) return "text-emerald-600";
  if (score >= 65) return "text-sky-600";
  if (score >= 45) return "text-amber-600";
  return "text-rose-600";
}

/** Convert the dynamic "custom::<slug>" key into a readable title. */
function benchmarkLabel(key: string, fallbackRole?: string): string {
  if (key.startsWith("custom::")) {
    const slug = key.slice("custom::".length);
    if (fallbackRole) return fallbackRole;
    return slug
      .split("-")
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(" ");
  }
  // Known static keys (keep this map small — add more as we add benchmarks).
  const STATIC: Record<string, string> = {
    "google-swe-intern": "Google SWE Intern",
    "data-engineer": "Data Engineer",
    "frontend-engineer": "Frontend Engineer",
    "ml-engineer": "ML Engineer",
  };
  return STATIC[key] ?? key;
}

export default function FitScorePage() {
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FitScoreResult | null>(null);
  // Cached role text the user typed when the result was generated — used
  // to render the benchmark title in the result panel after we clear the form.
  const [lastRole, setLastRole] = useState<string>("");

  async function onCompute() {
    if (loading) return;
    if (!role.trim() && !jd.trim()) {
      setError("Type a role or paste a job description first.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/fit-score", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Send only what the user actually provided. The server validates
          // that at least one is present and synthesises a benchmark for `role`.
          ...(role.trim() ? { role: role.trim() } : {}),
          ...(jd.trim() ? { jd: jd.trim() } : {}),
          persist: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { result: FitScoreResult };
      setResult(data.result);
      setLastRole(role.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to compute fit score.");
    } finally {
      setLoading(false);
    }
  }

  function onReset() {
    setRole("");
    setJd("");
    setError(null);
    setResult(null);
    setLastRole("");
  }

  const canSubmit = !loading && (role.trim().length > 0 || jd.trim().length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Fit Score, explained.
        </h1>
        <p className="mt-1 text-sm text-secondary-500">
          Type a role or paste a job description. We&apos;ll tell you what you
          have, what you&apos;re missing, and why you got that score.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
          {/* Role input — synthesises a benchmark anchored in the user's CV. */}
          <label
            htmlFor="role"
            className="text-xs font-semibold uppercase tracking-wider text-secondary-400"
          >
            Target role
          </label>
          <input
            id="role"
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="e.g. Senior React Engineer, MLOps, Data Engineer"
            className="mt-2 w-full rounded-lg border border-secondary-100 bg-secondary-50/40 px-3 py-2 text-sm outline-none focus:border-primary focus:bg-white"
            maxLength={200}
          />
          <p className="mt-1 text-[11px] text-secondary-400">
            We&apos;ll synthesise a benchmark for any role, anchored in your CV.
          </p>

          {/* Divider */}
          <div className="my-4 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wider text-secondary-400">
            <span className="h-px flex-1 bg-secondary-100" />
            or paste a full job description
            <span className="h-px flex-1 bg-secondary-100" />
          </div>

          <label
            htmlFor="jd"
            className="text-xs font-semibold uppercase tracking-wider text-secondary-400"
          >
            Job description
          </label>
          <textarea
            id="jd"
            rows={8}
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder="Paste the full role requirements here for the most accurate match…"
            className="mt-2 w-full resize-none rounded-lg border border-secondary-100 bg-secondary-50/40 p-3 text-sm outline-none focus:border-primary focus:bg-white"
            maxLength={24_000}
          />

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={onCompute}
              disabled={!canSubmit}
              className={clsx(
                "inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-card transition",
                !canSubmit
                  ? "cursor-not-allowed bg-primary/60"
                  : "bg-primary hover:bg-primary-600",
              )}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Scoring…
                </>
              ) : (
                <>
                  <GaugeIcon className="h-4 w-4" />
                  Compute fit
                </>
              )}
            </button>
            {result || jd || role ? (
              <button
                type="button"
                onClick={onReset}
                disabled={loading}
                className="rounded-lg border border-secondary-200 bg-white px-3 py-2.5 text-sm font-medium text-secondary-700 transition hover:bg-secondary-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Reset
              </button>
            ) : null}
          </div>
          {error ? (
            <p className="mt-3 inline-flex items-start gap-1.5 text-xs text-rose-600">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>

        <div className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
          {result ? (
            <ResultPanel result={result} roleLabel={lastRole} />
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-[16rem] flex-col items-center justify-center text-center">
      <Sparkles className="h-8 w-8 text-secondary-300" />
      <h2 className="mt-3 font-heading text-lg font-semibold">No run yet</h2>
      <p className="mt-1 max-w-sm text-sm text-secondary-500">
        Type a target role on the left, or paste a full job description. We&apos;ll
        compare it against your uploaded CV and break down the match.
      </p>
    </div>
  );
}

function ResultPanel({
  result,
  roleLabel,
}: {
  result: FitScoreResult;
  roleLabel: string;
}) {
  const ringPct = Math.max(0, Math.min(100, result.score));
  const scoredAgainst = benchmarkLabel(result.benchmarkUsed, roleLabel);
  // Heuristic: a score of 0 with no matched must-haves and no nice-to-haves
  // almost always means the user has no CV uploaded (or an empty one).
  // We surface a CTA to /cv in that case.
  const noCvEvidence =
    result.matched.length === 0 &&
    result.niceToHaveMatched.length === 0 &&
    result.missing.length > 0;

  return (
    <div className="space-y-5">
      {/* Header: score ring + verdict + rationale */}
      <div className="flex items-start gap-5">
        <div className="relative grid h-24 w-24 shrink-0 place-items-center">
          <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
            <circle
              cx="50"
              cy="50"
              r="44"
              className="fill-none stroke-secondary-100"
              strokeWidth="8"
            />
            <circle
              cx="50"
              cy="50"
              r="44"
              className={clsx("fill-none", scoreRingColor(result.score))}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 44}
              strokeDashoffset={2 * Math.PI * 44 * (1 - ringPct / 100)}
            />
          </svg>
          <span
            className={clsx(
              "font-heading text-2xl font-bold",
              scoreRingColor(result.score),
            )}
          >
            {result.score}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={clsx(
                "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1",
                verdictColor(result.verdict),
              )}
            >
              {VERDICT_LABEL[result.verdict]}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary-50 px-2 py-0.5 text-[11px] font-medium text-secondary-600 ring-1 ring-secondary-100">
              <Sparkles className="h-3 w-3 text-secondary-400" />
              {scoredAgainst}
            </span>
          </div>
          <p className="mt-2 text-sm font-medium text-secondary-800">
            {VERDICT_BLURB[result.verdict]}
          </p>
          <p className="mt-1 text-sm text-secondary-600">
            <span className="font-semibold text-secondary-700">Why this score: </span>
            {result.rationale}
          </p>
        </div>
      </div>

      {/* No-CV CTA. Trigger when there are no matched items at all. */}
      {noCvEvidence ? (
        <Link
          href="/cv"
          className="flex items-start gap-3 rounded-xl border border-primary-200 bg-primary-50/60 p-3 text-sm text-primary-900 transition hover:bg-primary-50"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-white">
            <UploadCloud className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold">Upload your CV to make this real</p>
            <p className="text-primary-800/80">
              We couldn&apos;t find any CV evidence for the must-haves. Upload a
              PDF or DOCX so we can ground the score in your real experience.
            </p>
          </div>
          <ArrowRight className="ml-auto h-4 w-4 shrink-0 self-center text-primary" />
        </Link>
      ) : null}

      <div className="rounded-lg bg-secondary-50/60 p-3 text-xs text-secondary-600">
        Experience: {result.experience.inferredYears}y vs{" "}
        {result.experience.requiredYears}y required
        {result.experience.yearsDelta > 0 ? " (over-qualified)" : null}
        {result.experience.yearsDelta < 0 ? " (under-qualified)" : null}
      </div>

      <SkillGroup
        title={`What you have (${result.matched.length})`}
        icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
        skills={result.matched.map((m) => m.skill)}
        empty="No must-haves matched."
        tone="positive"
      />

      <SkillGroup
        title={`What you're missing (${result.missing.length})`}
        icon={<XCircle className="h-4 w-4 text-rose-600" />}
        skills={result.missing.map((m) => m.skill)}
        empty="No critical gaps — nice work."
        tone="negative"
      />

      {result.niceToHaveMatched.length > 0 ? (
        <SkillGroup
          title={`Nice-to-haves you already have (${result.niceToHaveMatched.length})`}
          icon={<Sparkles className="h-4 w-4 text-sky-600" />}
          skills={result.niceToHaveMatched.map((m) => m.skill)}
          empty=""
          tone="neutral"
        />
      ) : null}

      <div className="flex items-center justify-between border-t border-secondary-100 pt-3 text-xs text-secondary-500">
        <span>Computed {new Date(result.computedAt).toLocaleString()}</span>
        <Link
          href="/chat"
          className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
        >
          Discuss in chat
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

function SkillGroup({
  title,
  icon,
  skills,
  empty,
  tone,
}: {
  title: string;
  icon: React.ReactNode;
  skills: Skill[];
  empty: string;
  tone: "positive" | "negative" | "neutral";
}) {
  const ringByTone: Record<typeof tone, string> = {
    positive: "ring-emerald-100 bg-emerald-50/40 text-secondary-800",
    negative: "ring-rose-100 bg-rose-50/40 text-secondary-800",
    neutral: "ring-secondary-100 bg-secondary-50/40 text-secondary-800",
  };
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-secondary-500">
        {icon}
        {title}
      </div>
      {skills.length === 0 ? (
        <p className="text-xs text-secondary-400">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {skills.map((s) => (
            <span
              key={s.id}
              className={clsx(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1",
                ringByTone[tone],
              )}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
