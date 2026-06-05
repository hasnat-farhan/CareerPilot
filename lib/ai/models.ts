// CareerPilot — Gemini model picker.
//
// Why this exists:
//   CareerPilot is currently on a free / demo Gemini tier. Different
//   assistant paths have different cost / quality trade-offs:
//
//     - High-volume, low-stakes paths (intent classifier, dynamic role
//       synthesis, general chat) should use a CHEAP model so the user
//       can click chips without burning the per-minute quota.
//     - User-facing, quality-sensitive paths (the 4 chip sub-agents —
//       readiness, gap analysis, roadmap, cover letter) deserve the
//       best model we have, even if it costs more RPM.
//
// Model budgets observed on the demo account (subject to change):
//
//   | Model              | RPM  | Tokens/min | RPD  | Quality |
//   |--------------------|------|------------|------|---------|
//   | gemini-3.1-flash-lite | 15   | 250K       | 500  | decent  |
//   | gemini-2.5-flash-lite | 10   | 250K       | 20   | decent  |
//   | gemini-3.5-flash      |  5   | 250K       | 10   | great   |
//   | gemini-2.5-flash      |  5   | 250K       | 20   | good    |
//
// Strategy:
//   - Quality tier: rotate 3.5-flash → 2.5-flash (best available).
//     Used for the 4 chip sub-agents.
//   - Economy tier: rotate 3.1-flash-lite → 2.5-flash-lite.
//     Used for the classifier, dynamic synthesis, and general chat.
//
// Every helper returns { model, maxOutputTokens }. The maxOutputTokens
// ceiling is conservative for the cheap tier (it has tighter per-call
// limits) and generous for the quality tier (user-visible output).

export type ModelTier = "quality" | "economy";

export interface ModelChoice {
  /** Gemini model id. */
  model: string;
  /**
   * Suggested maxOutputTokens for this call. Callers can still override
   * per-call (e.g. the cover letter agent needs 1200 to avoid truncation).
   */
  maxOutputTokens: number;
}

const QUALITY_MODELS: ModelChoice[] = [
  // 3.5-flash is the demo's best quality model. 2.5-flash is the fallback
  // if 3.5 ever exhausts on us.
  { model: "gemini-3.5-flash", maxOutputTokens: 1200 },
  { model: "gemini-2.5-flash", maxOutputTokens: 1200 },
];

const ECONOMY_MODELS: ModelChoice[] = [
  // Flash-lite variants have higher RPM/RPD and cost less. 3.1 first.
  { model: "gemini-3.1-flash-lite", maxOutputTokens: 800 },
  { model: "gemini-2.5-flash-lite", maxOutputTokens: 800 },
];

/**
 * Pick a model for a given tier. Rotates through the list deterministically
 * based on the current minute so a quick burst of calls is spread across
 * models instead of hammering one. (Single-process demo: no need for a
 * proper round-robin queue.)
 */
export function pickModel(tier: ModelTier): ModelChoice {
  const pool = tier === "quality" ? QUALITY_MODELS : ECONOMY_MODELS;
  // Simple time-based rotation. If the call later fails, callers can fall
  // back to the next model in the pool via `nextModel`.
  const minute = Math.floor(Date.now() / 60_000);
  const idx = minute % pool.length;
  // pool[idx] is defined because we just computed idx from pool.length
  return pool[idx] ?? pool[0]!;
}

/** Return the next-best model in the same tier, or null if exhausted. */
export function nextModel(
  tier: ModelTier,
  failedModel: string,
): ModelChoice | null {
  const pool = tier === "quality" ? QUALITY_MODELS : ECONOMY_MODELS;
  const idx = pool.findIndex((m) => m.model === failedModel);
  if (idx < 0 || idx + 1 >= pool.length) return null;
  return pool[idx + 1] ?? null;
}
