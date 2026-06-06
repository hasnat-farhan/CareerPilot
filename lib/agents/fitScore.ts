/**
 * Fit-score engine — the reusable heart of Pillar 3.
 *
 * `scoreFitScore` computes a 0..100 coverage score for a user against either:
 *   - a target role benchmark (lib/data/benchmarks), or
 *   - a raw job description (no benchmark), or
 *   - both (benchmark + JD — benchmark is the structural scorer, JD informs
 *     the rationale).
 *
 * The score combines three independent signals:
 *
 *   1. **Skill overlap** (60%): tokens from the user's CV are matched against
 *      the benchmark's mustHave + niceToHave skills via the shared vocabulary.
 *      Must-haves are weighted higher. Missing must-haves are a hard
 *      penalty; matched nice-to-haves are a soft bonus.
 *
 *   2. **Semantic similarity** (30%): cosine similarity between the embedded
 *      CV and the embedded (JD or benchmark summary). Catches phrasing
 *      differences the tokeniser misses.
 *
 *   3. **Experience / education** (10%): rough sanity check vs the
 *      benchmark's `minExperienceYears` and `minEducation`. Surfaces
 *      "you're under/over-qualified" signals.
 *
 * Finally we ask Gemini (cheap, responseSchema) to produce a 1-2 sentence
 * `rationale` that the chat route / fit-score page / assistant sub-agents
 * all surface verbatim. This is the only LLM call in the engine.
 *
 * No streaming. Pure function over inputs. Safe to cache by userId+jdHash.
 */

import { embedText, chatComplete } from "@/lib/ai/provider";
import { retrieveCvChunks, type Citation } from "@/lib/rag/retrieve-cv";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SchemaType, type Schema } from "@google/generative-ai";
import {
  buildSkillVocabulary,
  getBenchmark,
  type RoleBenchmark,
  type Skill,
} from "@/lib/data/benchmarks";

// ---------- Public types ----------

export interface FitScoreInput {
  userId: string;
  /** Raw JD text. Required if no benchmarkKey and no benchmark. */
  jd?: string;
  /** Benchmark key from lib/data/benchmarks. Optional. */
  benchmarkKey?: string;
  /**
   * Inline benchmark (e.g. one synthesised at runtime from a free-text role).
   * Takes precedence over `benchmarkKey` when both are set. The engine still
   * uses the same scoring logic — the inline object just skips the registry
   * lookup so dynamic benchmarks don't have to live in `BENCHMARKS`.
   */
  benchmark?: RoleBenchmark;
}

export interface ScoredSkill {
  skill: Skill;
  /** Whether the user's CV mentions this skill. */
  matched: boolean;
  /** Where it was matched (chunk id from retrieveCvChunks), if known. */
  evidence?: string;
}

export interface FitScoreResult {
  /** Final 0..100 score, rounded to nearest int. */
  score: number;
  /** 0..1 — the breakdown of how the score was assembled. */
  breakdown: {
    skillOverlap: number;
    semantic: number;
    experience: number;
  };
  /** Verdict label, derived from score band. */
  verdict: "strong" | "good" | "borderline" | "weak";
  /** Skills the user demonstrably has that match the role. */
  matched: ScoredSkill[];
  /** Must-have skills the user is missing. */
  missing: ScoredSkill[];
  /** Nice-to-have skills the user has. */
  niceToHaveMatched: ScoredSkill[];
  /** Experience/education signal vs the benchmark. */
  experience: {
    /** Years we extracted from the CV. */
    inferredYears: number;
    /** Years the benchmark expects. */
    requiredYears: number;
    /** Education level we inferred from the CV. */
    inferredEducation: RoleBenchmark["minEducation"] | "unknown";
    /** Education level the benchmark expects. */
    requiredEducation: RoleBenchmark["minEducation"];
    /** delta in years (positive = over-qualified, negative = under-qualified). */
    yearsDelta: number;
  };
  /** Gemini-generated 1-2 sentence explanation. */
  rationale: string;
  /** CV chunks we used as evidence (subset of retrieveCvChunks output). */
  citations: Citation[];
  /** Benchmark key actually used (always set, even if jd-only we set "_freeform"). */
  benchmarkUsed: string;
  /** When this was computed (ISO). */
  computedAt: string;
}

// ---------- Scoring helpers ----------

const VERDICT_BANDS: Array<[FitScoreResult["verdict"], number]> = [
  ["strong", 80],
  ["good", 65],
  ["borderline", 45],
  ["weak", 0],
];

function verdictFor(score: number): FitScoreResult["verdict"] {
  for (const [label, min] of VERDICT_BANDS) {
    if (score >= min) return label;
  }
  return "weak";
}

/**
 * Extract skills from a chunk of CV/JD text using the global vocabulary.
 * Returns the list of unique Skill objects that appear in the text.
 *
 * Matching is token-bounded and case-insensitive to avoid false positives
 * ("go" matching inside "Google"). We special-case the shortest tokens
 * (≤2 chars) with explicit whole-word matching.
 */
export function extractSkillsFromText(text: string): Skill[] {
  const vocab = buildSkillVocabulary();
  const lower = ` ${text.toLowerCase()} `;
  const found = new Map<string, Skill>();

  for (const [token, skill] of vocab.entries()) {
    if (found.has(skill.id)) continue;
    const needle = token.toLowerCase();
    const matched =
      needle.length <= 2
        ? new RegExp(`\\b${escapeRe(needle)}\\b`, "i").test(text)
        : lower.includes(needle);
    if (matched) found.set(skill.id, skill);
  }
  return [...found.values()];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface InferredProfile {
  years: number;
  education: RoleBenchmark["minEducation"] | "unknown";
}

const EDUCATION_RANK: Record<RoleBenchmark["minEducation"] | "unknown", number> = {
  unknown: 0,
  high_school: 1,
  associate: 2,
  bachelor: 3,
  master: 4,
  phd: 5,
};

/**
 * Cheap heuristic: scan CV chunks for "X years" patterns and degree keywords.
 * Real implementation will lean on a structured CV profile once `lib/cv/`
 * lands. Good enough for a v1 signal.
 */
export function inferProfile(citations: Citation[]): InferredProfile {
  let years = 0;
  let education: InferredProfile["education"] = "unknown";
  for (const c of citations) {
    const t = c.text.toLowerCase();
    const yr = t.match(/(\d{1,2})\+?\s+years?/);
    if (yr) years = Math.max(years, parseInt(yr[1]!, 10));
    if (/ph\.?d|doctorate/.test(t)) education = "phd";
    else if (/master|m\.?s\.?c|m\.?eng|mba/.test(t)) education = "master";
    else if (/bachelor|b\.?s\.?c|b\.?a\.? |b\.?eng|b\.?tech|undergraduate/.test(t))
      education = "bachelor";
    else if (/associate|diploma/.test(t)) education = "associate";
    else if (/high school|secondary/.test(t)) education = "high_school";
  }
  return { years, education };
}

// ---------- Rationale generation ----------

const RATIONALE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    rationale: {
      type: SchemaType.STRING,
      description:
        "A 1-2 sentence explanation of the score. Be specific — name the top strengths and the top 1-2 gaps. No filler.",
    },
  },
  required: ["rationale"],
};

async function generateRationale(
  score: number,
  benchmark: RoleBenchmark | null,
  matched: Skill[],
  missing: Skill[],
  jd: string | undefined,
): Promise<string> {
  const target = benchmark ? benchmark.title : "this role";
  const prompt =
    `You are a career coach. The user has a fit score of ${score}/100 for ${target}.\n` +
    `Top strengths: ${matched.slice(0, 4).map((s) => s.label).join(", ") || "none identified"}.\n` +
    `Top gaps: ${missing.slice(0, 3).map((s) => s.label).join(", ") || "no critical gaps"}.\n` +
    (jd ? `JD excerpt: ${jd.slice(0, 400)}…\n` : "") +
    `\nReturn a JSON object with a single "rationale" field: a 1-2 sentence explanation. No preamble.`;
  try {
    const raw = await chatComplete(
      [{ role: "user", parts: prompt }],
      {
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 256,
          // Gemini's responseMimeType/responseSchema live in generationConfig.
          responseMimeType: "application/json",
          responseSchema: RATIONALE_SCHEMA,
        },
      },
    );
    const parsed = JSON.parse(raw) as { rationale?: string };
    return parsed.rationale?.trim() || "Score reflects your strongest matches and remaining gaps.";
  } catch {
    // Rationale is non-critical; never fail the whole call because of it.
    return "Score reflects your strongest matches and remaining gaps.";
  }
}

// ---------- Main entry point ----------

export async function scoreFitScore(input: FitScoreInput): Promise<FitScoreResult> {
  const { userId, jd, benchmarkKey, benchmark: inlineBenchmark } = input;
  if (!jd && !benchmarkKey && !inlineBenchmark) {
    throw new Error("scoreFitScore requires either jd, benchmarkKey, or benchmark");
  }

  // Inline benchmark wins (used by the dynamic synthesiser). Otherwise fall
  // back to the static registry. `getBenchmark` throws on unknown keys — we
  // surface that to the caller, who should have validated first.
  const benchmark: RoleBenchmark | null = inlineBenchmark
    ? inlineBenchmark
    : benchmarkKey
      ? getBenchmark(benchmarkKey)
      : null;

  // 1. Pull CV evidence. Query is the JD (if present) or benchmark summary.
  const queryForRetrieval = jd ?? benchmark?.summary ?? "career experience";
  const citations = await retrieveCvChunks(userId, queryForRetrieval, 6);

  // 2. Skill overlap.
  //    - CV-driven: extract from citations.
  //    - JD-driven: extract from the JD text directly (extra hits).
  const cvSkills = extractSkillsFromText(citations.map((c) => c.text).join("\n"));
  const jdSkills = jd ? extractSkillsFromText(jd) : [];
  const cvSkillSet = new Map<string, Skill>();
  for (const s of [...cvSkills, ...jdSkills]) cvSkillSet.set(s.id, s);
  const userSkills = [...cvSkillSet.values()];

  const mustHave = benchmark?.mustHave ?? [];
  const niceToHave = benchmark?.niceToHave ?? [];

  const matched: ScoredSkill[] = [];
  const missing: ScoredSkill[] = [];
  for (const s of mustHave) {
    const hit = userSkills.find((u) => u.id === s.id);
    if (hit) matched.push({ skill: s, matched: true });
    else missing.push({ skill: s, matched: false });
  }
  const niceToHaveMatched: ScoredSkill[] = niceToHave
    .filter((s) => userSkills.some((u) => u.id === s.id))
    .map((s) => ({ skill: s, matched: true }));

  // Score the skill-overlap component.
  const mustWeightSum = mustHave.reduce((a, s) => a + (s.weight ?? 1), 0) || 1;
  const matchedMustWeight = matched.reduce((a, m) => a + (m.skill.weight ?? 1), 0);
  const niceWeightSum = niceToHave.reduce((a, s) => a + (s.weight ?? 1), 0) || 1;
  const matchedNiceWeight = niceToHaveMatched.reduce(
    (a, m) => a + (m.skill.weight ?? 1),
    0,
  );
  const skillComponent =
    benchmark === null
      ? // No benchmark → score from raw JD signals only.
        Math.min(1, userSkills.length / 8)
      : 0.7 * (matchedMustWeight / mustWeightSum) +
        0.3 * (niceWeightSum === 0 ? 0 : matchedNiceWeight / niceWeightSum);

  // 3. Semantic similarity (CV vs JD, or CV vs benchmark summary).
  let semantic = 0;
  try {
    const cvVec = await embedText(citations.map((c) => c.text).join("\n").slice(0, 2000), {
      taskType: "RETRIEVAL_DOCUMENT",
    });
    const targetVec = await embedText(jd ?? benchmark?.summary ?? "", {
      taskType: "RETRIEVAL_QUERY",
    });
    semantic = Math.max(0, cosine(cvVec, targetVec));
  } catch {
    semantic = 0;
  }

  // 4. Experience / education.
  const profile = inferProfile(citations);
  const requiredYears = benchmark?.minExperienceYears ?? 0;
  const requiredEdu = benchmark?.minEducation ?? "bachelor";
  const yearsDelta = profile.years - requiredYears;
  const eduDelta = EDUCATION_RANK[profile.education] - EDUCATION_RANK[requiredEdu];
  // 1.0 if right at the bar, <1 if under, >1 if over.
  const yearRatio =
    requiredYears === 0
      ? Math.min(1, 0.5 + profile.years * 0.1)
      : Math.min(1.2, Math.max(0, 1 + yearsDelta / Math.max(requiredYears, 1)));
  const eduRatio = Math.max(0.6, Math.min(1.2, 1 + eduDelta * 0.15));
  const experienceComponent = 0.5 * yearRatio + 0.5 * eduRatio - 0.5; // centre at 0.5, 0..1
  const experienceClamped = Math.max(0, Math.min(1, experienceComponent));

  // 5. Combine.
  const total =
    0.6 * skillComponent + 0.3 * semantic + 0.1 * experienceClamped;
  const score = Math.round(Math.max(0, Math.min(1, total)) * 100);

  // 6. Rationale.
  const rationale = await generateRationale(
    score,
    benchmark,
    matched.map((m) => m.skill),
    missing.map((m) => m.skill),
    jd,
  );

  return {
    score,
    breakdown: {
      skillOverlap: round3(skillComponent),
      semantic: round3(semantic),
      experience: round3(experienceClamped),
    },
    verdict: verdictFor(score),
    matched,
    missing,
    niceToHaveMatched,
    experience: {
      inferredYears: profile.years,
      requiredYears,
      inferredEducation: profile.education,
      requiredEducation: requiredEdu,
      yearsDelta,
    },
    rationale,
    citations,
    benchmarkUsed: benchmark?.key ?? "_freeform",
    computedAt: new Date().toISOString(),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------- Convenience: latest cached fit-score (for the dashboard) ----------

export async function getLatestFitScore(userId: string): Promise<FitScoreResult | null> {
  const { data, error } = await supabaseAdmin
    .from("fit_scores")
    .select("result, jd, benchmark_key, computed_at")
    .eq("user_id", userId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  // Persisted rows are a JSON snapshot; we trust the type at the boundary.
  return {
    ...(data.result as Omit<FitScoreResult, "citations">),
    citations: [],
  } as FitScoreResult;
}
