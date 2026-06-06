// CareerPilot — Dynamic (on-the-fly) role benchmarks.
//
// The static BENCHMARKS registry in `types.ts` covers four curated roles.
// The chat page lets a user type ANY role they want ("MLOps Engineer at
// a fintech", "Junior iOS Developer", "Solutions Architect"). For those
// we synthesise a `RoleBenchmark` on demand from the user's CV, using a
// small Gemini call. The result is cached for the lifetime of the
// process keyed by `${userId}::${roleSlug}` so repeated clicks on the
// same chip don't re-spend quota.
//
// Caching is intentionally in-memory: the same role synthesised twice
// in a session should cost 1 call, not N. For multi-instance production
// we'd move the cache to Redis with a short TTL.

import type { ChatMessage } from "@/lib/ai/provider";
import { chatComplete } from "@/lib/ai/provider";
import { retrieveCvChunks } from "@/lib/rag/retrieve-cv";
import { extractSkillsFromText } from "@/lib/agents/fitScore";
import { SchemaType, type Schema } from "@google/generative-ai";
import type { RoleBenchmark, Skill } from "./types";

const skillSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    id: { type: SchemaType.STRING },
    label: { type: SchemaType.STRING },
    weight: { type: SchemaType.NUMBER },
    category: { type: SchemaType.STRING },
  },
  required: ["id", "label"],
};

const SYNTHESIS_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING },
    summary: { type: SchemaType.STRING },
    mustHave: { type: SchemaType.ARRAY, items: skillSchema },
    niceToHave: { type: SchemaType.ARRAY, items: skillSchema },
    minExperienceYears: { type: SchemaType.NUMBER },
  },
  required: ["title", "summary", "mustHave", "niceToHave", "minExperienceYears"],
};

const DYNAMIC_PREFIX = "custom::";
const CACHE = new Map<string, RoleBenchmark>();

/** Convert free-text role input to a stable, URL-safe cache key. */
function slugifyRole(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "custom-role";
}

function cacheKey(userId: string, roleInput: string): string {
  return `${userId}::${slugifyRole(roleInput)}`;
}

/**
 * Get (or build) a RoleBenchmark for a free-text role. Calls Gemini once
 * per (user, role) pair; subsequent calls return the cached result.
 *
 * We use the user's fit-score snapshot as ground truth so the synthesised
 * benchmark reflects what the user *actually* has, not just generic role
 * descriptions. If the user has no CV uploaded yet we fall back to a
 * minimal benchmark so the chip still works.
 */
export async function getOrSynthesiseBenchmark(
  userId: string,
  roleInput: string,
): Promise<RoleBenchmark> {
  const cleanInput = roleInput.trim();
  if (!cleanInput) {
    throw new Error("[dynamic] empty role input");
  }
  const key = cacheKey(userId, cleanInput);
  const hit = CACHE.get(key);
  if (hit) return hit;

  // Try to anchor the synthesis in the user's real CV. We only pull RAG chunks
  // and extract skills directly — calling scoreFitScore() here used to crash
  // on users with no CV (embedText throws on empty input, see fitScore.ts
  // semantic step). The skill list is just a hint for the synthesis prompt;
  // empty is fine.
  let userStrengthLabels: string[] = [];
  let userYears = 0;
  try {
    const citations = await retrieveCvChunks(userId, cleanInput, 6);
    const joined = citations.map((c) => c.text).join("\n");
    if (joined.trim()) {
      userStrengthLabels = extractSkillsFromText(joined)
        .slice(0, 12)
        .map((s) => s.label);
      const yr = joined.match(/(\d{1,2})\+?\s+years?/i);
      if (yr) userYears = parseInt(yr[1]!, 10);
    }
  } catch {
    // No CV yet, or RAG failed — synthesise without anchoring.
  }

  const prompt =
    `You are designing a role benchmark for the position: "${cleanInput}".\n\n` +
    `The candidate's known strengths (from their CV): ` +
    (userStrengthLabels.length
      ? userStrengthLabels.slice(0, 10).join(", ")
      : "no CV uploaded yet") +
    `\nCandidate's inferred years of experience: ${userYears}\n\n` +
    `Return JSON describing a benchmark that:\n` +
    `1. Lists 6-10 must-have skills for this role. Use the canonical industry naming ` +
    `(e.g. "Kubernetes", "Apache Spark", "React"). Use weights 0.5-1.0.\n` +
    `2. Lists 3-6 nice-to-have skills. Use weights 0.3-0.6.\n` +
    `3. Sets minExperienceYears to a realistic number (0-5 for junior, 2-5 for mid, 5+ for senior).\n` +
    `4. Summary is one sentence describing the role.\n\n` +
    `Do not include skill ids the user clearly already has in must-haves unless the role truly requires them at expert level — those go in nice-to-have.`;

  const messages: ChatMessage[] = [{ role: "user", parts: prompt }];
  const raw = await chatComplete(messages, {
    tier: "quality",
    systemInstruction:
      "You design role benchmarks. Be specific, name real skills, no fluff. " +
      "Return only the JSON described in the schema.",
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      responseSchema: SYNTHESIS_SCHEMA,
    },
  });
  const parsed = parseSynthesisResponse(raw, cleanInput);
  if (!parsed.ok) {
    // Synthesis failed. Don't crash the chip — fall back to a
    // minimal-but-valid heuristic benchmark so the structured
    // sub-agent (roadmap / gaps / readiness) can still run.
    // Without this fallback the chat route silently drops the user
    // back into general chat, which breaks the structured card.
    console.warn(
      "[dynamic] synthesis failed, using heuristic benchmark:",
      parsed.error,
    );
    return buildHeuristicBenchmark(cleanInput);
  }

  // Synthesised cleanly. Map the model output to the canonical
  // RoleBenchmark shape (slug, weights clamped, defaults filled).
  const v = parsed.value;

  const mapSkill = (s: { id: string; label: string; weight?: number; category?: string }): Skill => ({
    id: s.id,
    label: s.label,
    ...(typeof s.weight === "number" ? { weight: Math.max(0, Math.min(1, s.weight)) } : {}),
    ...(s.category ? { category: s.category } : {}),
  });

  const benchmark: RoleBenchmark = {
    key: DYNAMIC_PREFIX + slugifyRole(cleanInput),
    title: v.title || cleanInput,
    summary: v.summary || `Custom role: ${cleanInput}`,
    domain: "Custom",
    mustHave: v.mustHave.slice(0, 10).map(mapSkill),
    niceToHave: v.niceToHave.slice(0, 8).map(mapSkill),
    minExperienceYears: Math.max(0, Math.min(20, Math.floor(v.minExperienceYears ?? 1))),
    minEducation: "bachelor",
    keywords: slugifyRole(cleanInput).split("-"),
    notes: "Synthesised on demand from the user's role input.",
  };

  CACHE.set(key, benchmark);
  return benchmark;
}

/** True if a benchmark key was generated by the dynamic synthesizer. */
export function isDynamicBenchmarkKey(key: string): boolean {
  return key.startsWith(DYNAMIC_PREFIX);
}

/** Invalidate a single cache entry (used when the user updates their CV). */
export function invalidateDynamicBenchmark(roleInput: string): void {
  for (const k of CACHE.keys()) {
    if (k.endsWith("::" + slugifyRole(roleInput))) CACHE.delete(k);
  }
}

/** List currently cached custom roles — for the UI's datalist suggestions. */
export function listCustomRoles(): string[] {
  const set = new Set<string>();
  for (const b of CACHE.values()) set.add(b.title);
  return [...set];
}
// ---------- Internal: resilient parsing + heuristic fallback ----------

interface SynthesisValue {
  title: string;
  summary: string;
  mustHave: { id: string; label: string; weight?: number; category?: string }[];
  niceToHave: { id: string; label: string; weight?: number; category?: string }[];
  minExperienceYears: number;
}

type ParseResult =
  | { ok: true; value: SynthesisValue }
  | { ok: false; error: string };

/**
 * Parse the Gemini synthesis response. We:
 *   1. Strip ```json / ``` fences if the model added them.
 *   2. Try a plain JSON.parse.
 *   3. If that fails (truncated output, stray quotes), try to repair
 *      by closing the open string + open object. This recovers from
 *      `maxOutputTokens` truncation in the common case.
 */
function parseSynthesisResponse(raw: string, fallbackTitle: string): ParseResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // First attempt: vanilla parse.
  try {
    return { ok: true, value: JSON.parse(cleaned) as SynthesisValue };
  } catch (firstErr) {
    // Second attempt: try to repair common truncation/malformation
    // by closing any open string + object. We bail with a clear error
    // if the repair can't produce parseable JSON.
    const repaired = attemptRepair(cleaned);
    try {
      return { ok: true, value: JSON.parse(repaired) as SynthesisValue };
    } catch (secondErr) {
      return {
        ok: false,
        error: `raw parse failed (${(firstErr as Error).message}); ` +
          `repair parse failed (${(secondErr as Error).message}); ` +
          `head=${cleaned.slice(0, 80).replace(/\s+/g, " ")}`,
      };
    }
  }
}

/**
 * Best-effort repair of a JSON string that the model truncated mid-write.
 *
 * Strategy: walk char-by-char, tracking whether we're inside a string.
 * When we hit EOF mid-string, close it. Then count `{` and `}` and
 * append the missing closers. This handles the most common case where
 * the model ran out of output tokens on the last `niceToHave` entry.
 */
function attemptRepair(raw: string): string {
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
    }
  }
  let s = raw;
  if (inString) s += '"';
  // Strip a trailing comma so the JSON is well-formed after a close.
  s = s.replace(/,\s*$/, "");
  // Balance braces/brackets.
  const opens: string[] = [];
  let inStr2 = false;
  let esc2 = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (esc2) {
      esc2 = false;
      continue;
    }
    if (c === "\\") {
      esc2 = true;
      continue;
    }
    if (c === '"') {
      inStr2 = !inStr2;
      continue;
    }
    if (inStr2) continue;
    if (c === "{" || c === "[") opens.push(c);
    else if (c === "}" || c === "]") opens.pop();
  }
  // `opens` now contains all unclosed openers in order; we close them
  // in reverse to produce a valid suffix.
  const closers = opens.reverse().map((o) => (o === "{" ? "}" : "]")).join("");
  return s + closers;
}

/**
 * Last-resort benchmark built from the role string itself, with no
 * assumed skills. The structured sub-agents (roadmap / gaps / readiness)
 * will still run and will give the user a useful answer grounded in
 * their CV + the role title. Better than silently dropping the user
 * into general chat.
 */
function buildHeuristicBenchmark(roleInput: string): RoleBenchmark {
  const slug = slugifyRole(roleInput);
  return {
    key: DYNAMIC_PREFIX + (slug || "custom-role"),
    title: roleInput,
    summary: `Custom role: ${roleInput}. Heuristic profile (synthesis unavailable).`,
    domain: "Custom",
    mustHave: [],
    niceToHave: [],
    minExperienceYears: 1,
    minEducation: "bachelor",
    keywords: slug ? slug.split("-") : [roleInput.toLowerCase()],
    notes:
      "Heuristic fallback used when dynamic synthesis returned malformed JSON. " +
      "Has no must-have skills, so the fit-score engine will use the user's full CV " +
      "as the basis for any role-specific advice.",
  };
}