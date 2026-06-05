"use client";

import { useState } from "react";
import { clsx } from "clsx";
import {
  Gauge as GaugeIcon,
  Loader2,
  CheckCircle2,
  XCircle,
  Sparkles,
  ArrowRight,
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

export default function FitScorePage() {
  const [jd, setJd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FitScoreResult | null>(null);

  async function onCompute() {
    if (!jd.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/fit-score", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jd, persist: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { result: FitScoreResult };
      setResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to compute fit score.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Fit Score, explained.
        </h1>
        <p className="mt-1 text-sm text-muted">
          Paste a job description. Get a transparent match percentage.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
          <label
            htmlFor="jd"
            className="text-xs font-semibold uppercase tracking-wider text-muted"
          >
            Job description
          </label>
          <textarea
            id="jd"
            rows={12}
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder="Paste the role requirements here…"
            className="mt-2 w-full resize-none rounded-lg border border-secondary-100 bg-surface/40 p-3 text-sm outline-none focus:border-primary focus:bg-white"
          />
          <button
            type="button"
            onClick={onCompute}
            disabled={!jd.trim() || loading}
            className={clsx(
              "mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-card transition",
              !jd.trim() || loading
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
          {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}
        </div>

        <div className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
          {result ? <ResultPanel result={result} /> : <EmptyState />}
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
      <p className="mt-1 max-w-sm text-sm text-muted">
        Run a fit score to see the breakdown here.
      </p>
    </div>
  );
}

function ResultPanel({ result }: { result: FitScoreResult }) {
  const ringPct = Math.max(0, Math.min(100, result.score));
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-5">
        <div className="relative grid h-24 w-24 place-items-center">
          <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
            <circle cx="50" cy="50" r="44" className="fill-none stroke-secondary-100" strokeWidth="8" />
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
          <span className={clsx("font-heading text-2xl font-bold", scoreRingColor(result.score))}>
            {result.score}
          </span>
        </div>
        <div className="flex-1">
          <span
            className={clsx(
              "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1",
              verdictColor(result.verdict),
            )}
          >
            {VERDICT_LABEL[result.verdict]}
          </span>
          <p className="mt-2 text-sm text-muted">{result.rationale}</p>
        </div>
      </div>

      <div className="rounded-lg bg-surface/60 p-3 text-xs text-muted">
        Experience: {result.experience.inferredYears}y vs {result.experience.requiredYears}y
        required
        {result.experience.yearsDelta > 0 ? " (over-qualified)" : null}
        {result.experience.yearsDelta < 0 ? " (under-qualified)" : null}
      </div>

      <SkillGroup
        title="Matched must-haves"
        icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
        skills={result.matched.map((m) => m.skill)}
        empty="No must-haves matched."
      />

      <SkillGroup
        title="Gaps to close"
        icon={<XCircle className="h-4 w-4 text-rose-600" />}
        skills={result.missing.map((m) => m.skill)}
        empty="No critical gaps."
      />

      {result.niceToHaveMatched.length > 0 ? (
        <SkillGroup
          title="Nice-to-haves matched"
          icon={<Sparkles className="h-4 w-4 text-sky-600" />}
          skills={result.niceToHaveMatched.map((m) => m.skill)}
          empty=""
        />
      ) : null}

      <div className="flex items-center justify-between border-t border-secondary-100 pt-3 text-xs text-muted">
        <span>Computed {new Date(result.computedAt).toLocaleString()}</span>
        <a
          href="/chat"
          className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
        >
          Discuss in chat
          <ArrowRight className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

function SkillGroup({
  title,
  icon,
  skills,
  empty,
}: {
  title: string;
  icon: React.ReactNode;
  skills: Skill[];
  empty: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {icon}
        {title}
      </div>
      {skills.length === 0 ? (
        <p className="text-xs text-muted">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {skills.map((s) => (
            <span
              key={s.id}
              className="inline-flex items-center rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-muted ring-1 ring-secondary-100"
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
