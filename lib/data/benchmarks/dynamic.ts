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
  const parsed = JSON.parse(raw) as {
    title: string;
    summary: string;
    mustHave: { id: string; label: string; weight?: number; category?: string }[];
    niceToHave: { id: string; label: string; weight?: number; category?: string }[];
    minExperienceYears: number;
  };

  const mapSkill = (s: { id: string; label: string; weight?: number; category?: string }): Skill => ({
    id: s.id,
    label: s.label,
    ...(typeof s.weight === "number" ? { weight: Math.max(0, Math.min(1, s.weight)) } : {}),
    ...(s.category ? { category: s.category } : {}),
  });

  const benchmark: RoleBenchmark = {
    key: DYNAMIC_PREFIX + slugifyRole(cleanInput),
    title: parsed.title || cleanInput,
    summary: parsed.summary || `Custom role: ${cleanInput}`,
    domain: "Custom",
    mustHave: parsed.mustHave.slice(0, 10).map(mapSkill),
    niceToHave: parsed.niceToHave.slice(0, 8).map(mapSkill),
    minExperienceYears: Math.max(0, Math.min(20, Math.floor(parsed.minExperienceYears ?? 1))),
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
