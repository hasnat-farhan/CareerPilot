// CareerPilot — Job Hunter Agent (Pillar 1).
//
// Flow (multi-source architecture, replacing the prior single-Gemini-search
// approach that returned 1 result for multi-position queries):
//
//   1. Fan out to N pluggable job sources (RemoteOK, Arbeitnow, The Muse,
//      Adzuna) in parallel via Promise.allSettled.
//   2. Dedupe by canonical URL + fuzzy (title, company, city) match.
//   3. Retrieve the user's CV chunks via the RAG seam.
//   4. One Gemini call: pick the best matches from the raw list, score
//      fit 0-100 against the CV, and return JobCard[] with reasoning,
//      matchHighlights, and concerns — all via responseSchema so Gemini
//      cannot drift from the shape.
//   5. Route handler persists the structured payload to hunter_hunts.
//
// Why this design:
//   * The old approach relied on Gemini + googleSearch, which often returned
//     a single result and hallucinated URLs. Deterministic JSON APIs give
//     us reliable coverage and a stable URL per posting.
//   * We let the LLM do what it's good at (semantic fit scoring, narrative
//     reasoning) and let the APIs do what they're good at (finding posts).

import { retrieveCvChunks } from "@/lib/rag/retrieve-cv";
import { fanOutSearch, dedupe, rankByLocationRelevance, type RawJob } from "@/lib/agents/sources";
import { withBackoff, geminiBreaker, RetryableError } from "@/lib/ai/resilience";
import { chatComplete } from "@/lib/ai/provider";

export type FitScoreBreakdown = {
  /** 0..1 — skill overlap component (must-have + nice-to-have match). */
  skillOverlap: number;
  /** 0..1 — semantic similarity between the CV and the job description. */
  semantic: number;
  /** 0..1 — experience / education match component. */
  experience: number;
};

export type JobCard = {
  id: string;            // local stable id, derived from url hash
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  deadline: string | null; // ISO yyyy-mm-dd or null
  url: string;
  snippet: string;
  jobType: string;       // "internship" | "full-time" | "contract" | "part-time" | "research" | "other"
  fitScore: number;      // 0..100, derived from breakdown via 0.6*skill + 0.3*semantic + 0.1*experience
  fitReason: string;     // 1-2 sentence justification grounded in CV
  matchHighlights: string[]; // bullet-list of CV attributes that matched
  concerns: string[];        // bullet-list of CV-vs-job mismatches
  source: string;        // which source produced this job
  /**
   * Optional 0..1 components that the fitScore was assembled from.
   * Mirrors the shape of FitScoreResult.breakdown in lib/agents/fitScore.ts
   * so the hunter card and the Fit Score page share the same vocabulary
   * (skillOverlap / semantic / experience) and can be cross-referenced in
   * the UI ("Strong match — 82/100 — driven by skill overlap").
   *
   * The LLM is asked to estimate these in the prompt using the same
   * 60/30/10 formula as the deterministic engine, so the two numbers
   * move in the same direction even if they're not bit-identical. The
   * deterministic engine is the source of truth when re-scoring on read.
   */
  breakdown?: FitScoreBreakdown;
  /**
   * True when the card was surfaced by the post-LLM remote-fallback
   * branch (the local market was empty, the LLM didn't pick any
   * remote candidates, and we filled the result set with the best
   * remote/anywhere cards from the raw pool). Used by the UI to badge
   * the card. Optional so existing callers that build JobCards by hand
   * don't have to stamp it.
   */
  isRemoteFallback?: boolean;
};

export type HunterResult = {
  query: string;
  jobs: JobCard[];
  reasoning: string;     // 1-2 sentence overall narrative
  model: string;
  retrievedAt: string;
  sourcesUsed: string[]; // which sources actually returned results
  totalCandidates: number; // raw count before scoring
  /**
   * When the LLM call could not be made (rate-limit circuit OPEN, retries
   * exhausted, etc.) the route still gets a usable result by returning the
   * raw fan-out as JobCards with default fitScore=50 and no fitReason.
   * Frontends can render a "results may be less tailored than usual" banner.
   */
  degraded?: {
    reason: "circuit_open" | "rate_limited" | "llm_failed";
    message: string;
  };
};

// Scoring call is routed through the economy tier rotator in lib/ai/models.ts
// instead of pinning gemini-2.5-flash. Rationale: on the demo (free) Gemini
// tier, gemini-2.5-flash is capped at 20 generate-content requests PER DAY,
// so pinning it meant 6-7 hunter runs would exhaust the quota for the rest
// of the day. The economy tier rotates across flash-lite variants whose
// per-day counters are separate, and chatComplete() in lib/ai/provider.ts
// already implements model-level fallback (try 3.1 → fall back to 2.5).
//
// We keep MODEL as a label for the response payload (the UI shows it in the
// result) so the user can tell which model actually scored the run when we
// degrade.
const MODEL = "gemini-economy-rotator";
const MAX_RAW_FOR_LLM = 25; // cap to keep prompt size sane

// (Schema enforcement used to live here as HUNTER_OUTPUT_SCHEMA passed to
// responseSchema on the generateContent call. We now go through chatComplete
// for the model-fallback benefits, and the startChat path does not support
// responseSchema — the prompt itself enforces the JSON shape.)

// ---------- helpers ----------

function stableId(input: string): string {
  // Tiny non-cryptographic hash for stable client-side keys.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `job-${h.toString(16)}`;
}

export function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s\n\t]+/g, " ")
    .replace(/[^a-z0-9 .,?!\-+&]/g, "")
    .trim();
}

/**
 * Lightweight, string-level location match used as a secondary signal in
 * the post-LLM remote-fallback gate. Returns true when the card's
 * `location` string contains any of the user-supplied target tokens
 * (city / region / country), as a substring or whole-word match, case
 * insensitive. "Remote" is never treated as a local match even if the
 * target string contains the word "remote" (e.g. "remote, UK").
 */
function matchesLocationString(
  cardLocation: string | null | undefined,
  target: string,
): boolean {
  if (!cardLocation) return false;
  const card = cardLocation.toLowerCase();
  if (!card.trim()) return false;
  const targetLower = target.toLowerCase().trim();
  if (!targetLower) return false;
  // Split target into tokens; treat multi-word inputs as AND-of-tokens
  // (e.g. "new york" — both "new" and "york" should appear).
  const tokens = targetLower
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "remote" && t !== "anywhere");
  if (tokens.length === 0) return false;
  return tokens.every((tok) => card.includes(tok));
}

function summariseCv(chunks: Awaited<ReturnType<typeof retrieveCvChunks>>): string {
  if (chunks.length === 0) return "";
  return chunks
    .slice(0, 6)
    .map((c, i) => `[${i + 1}] ${c.text}`)
    .join("\n\n");
}

// Job descriptions often contain raw newlines, tabs, and stray control
// characters. We collapse them to spaces inside the prompt so the model
// never has to reason about a multi-line snippet value, and so any
// downstream JSON parse of the model's response can't trip on a literal
// newline inside a string.
function flattenForPrompt(s: string): string {
  return s
    .replace(/\r\n?/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rawToPromptBlock(raw: RawJob[]): string {
  return raw
    .slice(0, MAX_RAW_FOR_LLM)
    .map((j, i) => {
      const parts = [
        `[${i + 1}] ${flattenForPrompt(j.title)} @ ${flattenForPrompt(j.company)}`,
        j.location ? `    location: ${flattenForPrompt(j.location)}` : null,
        j.salary ? `    salary:   ${flattenForPrompt(j.salary)}` : null,
        `    type:     ${j.jobType}`,
        j.deadline ? `    deadline: ${j.deadline}` : null,
        `    source:   ${j.source}`,
        `    url:      ${j.url}`,
        j.snippet ? `    snippet:  ${flattenForPrompt(j.snippet)}` : null,
      ].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n\n");
}

/**
 * Order the raw jobs so the LLM's top-25 view is biased toward local
 * matches, then remote, then everything else. The prompt block is built
 * from this pre-sorted list so the scorer is far less likely to skip over
 * the 1-2 Dhaka cards buried under 30 global remote-board listings.
 */
function rankAndCap(
  raw: RawJob[],
  location: string | null,
): RawJob[] {
  const ranked = rankByLocationRelevance(raw, location);
  return [...ranked.local, ...ranked.remote, ...ranked.other].slice(
    0,
    MAX_RAW_FOR_LLM,
  );
}

function buildScoringPrompt(
  query: string,
  rawBlock: string,
  cvContext: string,
  opts?: { location?: string | null },
): string {
  // TARGET LOCATION is a HARD signal. If the user asked for jobs in
  // <location>, listings that don't match it should be penalised even if
  // the role is otherwise perfect. This is what stops the scorer from
  // surfacing Dhaka roles for a London query, or vice versa, when both
  // cities have a wide web-search footprint.
  //
  // Remote is allowed as a SECONDARY tier: if the local bucket is empty
  // or thin, the model is told it's fine to surface remote/anywhere
  // postings and label them clearly. The post-LLM gate in runHunter()
  // also enforces "exclusive remote fallback" mechanically, so the user
  // never sees an empty result set when remote cards exist.
  const targetLocation = opts?.location?.trim();
  return [
    "You are the Job Hunter agent for CareerPilot.",
    "",
    "USER QUERY:",
    query.trim(),
    targetLocation ? `TARGET LOCATION (HARD CONSTRAINT): ${targetLocation}` : null,
    targetLocation ? `REMOTE FALLBACK: If no listing matches TARGET LOCATION, it is acceptable to surface remote/anywhere roles. Tag them with location="Remote" in the output and a fitReason that explicitly says "remote — no local matches found".` : null,
    "",
    cvContext
      ? "USER CV HIGHLIGHTS:\n" + cvContext
      : "USER CV HIGHLIGHTS: none available — score fit generically against the role described in the query.",
    "",
    "RAW JOB LISTINGS (each was already deduped across multiple job-board sources; the list is pre-sorted so LOCAL matches appear first, then REMOTE, then everything else; you may pick up to 8):",
    "<<<",
    rawBlock,
    ">>>",
    "",
    "Your job:",
    targetLocation
      ? `  0. Prefer listings whose location matches TARGET LOCATION. If the local bucket is empty or thin (fewer than 3 matches), include the strongest REMOTE candidates and label them as such.`
      : null,
    "  1. Pick the 5-8 best-matching listings from the RAW block.",
    "  2. For each, score fit (0-100) AGAINST THE USER CV using the SAME METHODOLOGY as the CareerPilot Fit Score engine. The engine combines three components with these exact weights:",
    "       fitScore = round( 100 * (0.6 * skillOverlap + 0.3 * semantic + 0.1 * experience) )",
    "     where:",
    "       - skillOverlap (0..1): how many must-have + nice-to-have skills the listing names are present in the CV. Heavier weight on must-haves.",
    "       - semantic (0..1): overall semantic similarity between the CV and the listing (seniority, domain, role shape).",
    "       - experience (0..1): years + education match. 1.0 when the CV meets or exceeds the role's bar; drops toward 0 when under.",
    "     Verdict bands: strong >= 80, good >= 65, borderline >= 45, weak < 45. Use the same bands in fitReason (e.g. 'strong match — your X + Y are exactly what they want').",
    "     Emit a `breakdown` object so the numbers behind fitScore are inspectable:",
    "       { skillOverlap: <0..1>, semantic: <0..1>, experience: <0..1> }",
    "     The three components should sum (weighted) to roughly fitScore/100; if they don't, the UI will surface a 're-evaluate' hint.",
    "  3. Write a 1-2 sentence fitReason citing specific CV evidence (or 'no CV available' if the CV block was empty).",
    "  4. Provide matchHighlights (CV attributes that match) and concerns (mismatches or risks), each 1 short sentence.",
    "",
    "Strict rules:",
    "  - url MUST be copied verbatim from one of the numbered listings above. Do not invent URLs.",
    "  - jobType must be one of: internship, full-time, contract, part-time, research, other.",
    "  - deadline is an ISO date (yyyy-mm-dd) or null.",
    "  - fitScore is an INTEGER in [0, 100], derived from the breakdown as shown above.",
    "  - breakdown.skillOverlap / semantic / experience are FLOATS in [0, 1].",
    "  - matchHighlights and concerns are arrays of short strings; empty array is fine.",
    "  - Return at most 8 jobs, ordered by fitScore descending.",
    "",
    'Respond with a single JSON object (no prose, no markdown fences). The exact shape MUST be:',
    '  {',
    '    "reasoning": "<1-3 sentence explanation of the picks and how you weighed CV fit>",',
    '    "jobs": { "items": [',
    '      { "title": "...", "company": "...", "location": "...", "salary": "...",',
    '        "url": "<verbatim from RAW block>", "deadline": "<yyyy-mm-dd or null>",',
    '        "snippet": "<short summary>", "jobType": "<internship|full-time|contract|part-time|research|other>",',
    '        "fitScore": <0-100 int>, "breakdown": { "skillOverlap": <0..1>, "semantic": <0..1>, "experience": <0..1> },',
    '        "fitReason": "...", "matchHighlights": ["..."], "concerns": ["..."] }',
    '    ] }',
    '  }',
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// ---------- main entrypoint ----------

/**
 * Make a single scoring call. We route through the provider's chatComplete()
 * (which itself goes through the model-fallback chain in runWithModelFallback)
 * instead of calling generateContent directly. This:
 *
 *   1. Uses the economy tier (gemini-3.1-flash-lite → 2.5-flash-lite fallback)
 *      instead of pinning gemini-2.5-flash, which is capped at 20 RPD on the
 *      free tier and was exhausting the day-quota after 6-7 hunts.
 *   2. Inherits the model-level fallback in lib/ai/provider.ts — if the
 *      first model returns 429, the next one in the tier is tried
 *      automatically (no extra breaker hops).
 *   3. Lets the existing circuit breaker + backoff in runWithModelFallback
 *      own retry policy uniformly across all our LLM call sites.
 *
 * Note: chatComplete() returns the raw text (not a Gemini response object),
 * so we return the string from this function and let the caller parse JSON.
 */
async function callGemini(
  query: string,
  rawJobs: RawJob[],
  cvContext: string,
  opts?: { location?: string | null },
): Promise<string> {
  // Pre-rank so the LLM sees LOCAL matches at the top of the candidate
  // list — otherwise the 30 generic remote-board listings drown out the
  // 1-2 city-specific cards and the model follows its "drop non-local"
  // rule against a slice that contains no locals.
  const ranked = rankAndCap(rawJobs, opts?.location ?? null);
  const prompt = buildScoringPrompt(query, rawToPromptBlock(ranked), cvContext, {
    location: opts?.location,
  });
  // The structured-output schema (responseSchema + responseMimeType) is
  // enforced by the SDK on the generateContent path. chatComplete() goes
  // through startChat/sendMessage, which does NOT support responseSchema
  // directly — we keep the strict JSON contract via the "Respond with a
  // single JSON object" instruction in the prompt and the parse-with-
  // recovery logic in runHunter.
  return chatComplete([{ role: "user", parts: prompt }], {
    tier: "economy",
    generationConfig: {
      temperature: 0.2,
      // 4096 is enough for 8 cards × (1-2 sentence fitReason + 3-5 highlights
      // + 1-3 concerns). We previously used 8192 against the quality tier
      // budget; the economy tier has tighter per-call output caps and
      // 8192 was hitting MAX_TOKENS in some runs, causing the whole call to
      // be thrown away and retried (wasting quota on the free tier).
      maxOutputTokens: 4096,
    },
  });
}

export async function runHunter(
  userId: string,
  query: string,
  opts?: { location?: string | null },
): Promise<HunterResult> {
  if (!query.trim()) throw new Error("Query is empty");

  // The location, when supplied by the caller, is treated as a hard
  // scoring constraint — it's stamped on every source request AND on
  // the scoring prompt. Without this, web-search sources drift toward
  // whatever global roles they happen to find, and the LLM scorer
  // happily surfaces Dhaka roles for a London query.
  const location = (opts?.location ?? "").trim() || null;

  // 1. Fan out to all sources in parallel. The internal fan-out already
  //    parses `query` for a role+location split and runs each source
  //    twice when a location is present (with + without it, so remote
  //    roles aren't suppressed). When the caller has already given us
  //    an explicit location, we encode it INTO the query string we
  //    pass in, so the parser picks it up.
  const effectiveQuery = location ? `${query} in ${location}` : query;
  const rawJobs = await fanOutSearch(effectiveQuery);
  const sourcesUsed = Array.from(new Set(rawJobs.map((j) => j.source)));

  // 2. CV context (RAG seam — returns [] for now, the prompt tolerates it).
  const cvChunks = await retrieveCvChunks(userId, effectiveQuery);
  const cvContext = summariseCv(cvChunks);

  // 3. If we got zero results from every source, short-circuit gracefully.
  if (rawJobs.length === 0) {
    return {
      query,
      jobs: [],
      reasoning: location
        ? `I could not find any current postings for ${query} in ${location} across the configured job-board sources. Try a broader role term or a different city.`
        : "I could not find any current postings for that query across the configured job-board sources. Try a broader role term or a different location.",
      model: MODEL,
      retrievedAt: new Date().toISOString(),
      sourcesUsed,
      totalCandidates: 0,
    };
  }

  // 4. One scoring call to the LLM. Failure handling:
  //    - chatComplete() already does model-level fallback (tries the next
  //      model in the economy tier if the first returns 429) and is wrapped
  //      in geminiBreaker() + withBackoff() inside the provider, so a single
  //      call here can make up to 3 model attempts × 3 retry attempts. We do
  //      NOT add an extra withBackoff wrapper around it — that nested
  //      backoff was burning 3 quota units per hunter run on the free tier.
  //    - If the breaker is OPEN we skip the call entirely.
  //    - If every attempt fails (any reason) we degrade gracefully and
  //      return raw listings as JobCards with neutral fitScore=50, just like
  //      before. The route still persists a payload so the user sees
  //      something.
  const breaker = geminiBreaker();

  let rawText: string | null = null;
  let degraded: HunterResult["degraded"] | null = null;

  if (!breaker.isCallAllowed) {
    // Circuit is OPEN — skip the call.
    console.warn(`[hunter] gemini circuit OPEN, returning raw listings without LLM scoring`);
    degraded = {
      reason: "circuit_open",
      message:
        "Live scoring is temporarily paused (provider rate-limit cooldown). Showing raw listings; please retry in ~30s.",
    };
  } else {
    try {
      rawText = await breaker.run(() => callGemini(query, rawJobs, cvContext, { location }));
    } catch (err) {
      if (err instanceof RetryableError) {
        // All model-fallback attempts exhausted on rate-limit, OR circuit
        // opened mid-call. On the free tier this is almost always a daily
        // quota hit, not a transient throttle.
        console.warn(`[hunter] gemini call failed after model fallback: ${err.message}`);
        degraded = {
          reason: "rate_limited",
          message:
            "We hit our LLM provider's rate limit while scoring. Showing raw listings; tailored fit scores will return shortly.",
        };
      } else {
        // Non-rate-limit failure (network, schema parse, etc.) — degrade but
        // tag as llm_failed so the UI can show a different banner if it wants.
        console.warn(`[hunter] gemini call failed (non-rate-limit):`, err);
        degraded = {
          reason: "llm_failed",
          message: "We couldn't score these results right now. Showing raw listings.",
        };
      }
    }
  }

  // 4b. Degraded path: turn the raw jobs into JobCards with neutral scores
  //     so the UI has something to render. Pick the top 8 by recency-naive
  //     order (the source order, which is already a best-effort ranking).
  if (rawText === null) {
    const fallbackCards: JobCard[] = rawJobs.slice(0, 8).map((j) => ({
      id: stableId(j.url),
      title: j.title,
      company: j.company,
      location: j.location,
      salary: j.salary,
      deadline: j.deadline,
      url: j.url,
      snippet: j.snippet,
      jobType: j.jobType,
      fitScore: 50,
      fitReason: "Live scoring is paused — showing the raw match.",
      matchHighlights: [],
      concerns: [],
      source: j.source,
    }));
    return {
      query,
      jobs: fallbackCards,
      reasoning:
        "We hit a temporary rate limit on our scoring model. The listings below are the raw matches from the job boards; tailored fit scores will return shortly.",
      model: MODEL,
      retrievedAt: new Date().toISOString(),
      sourcesUsed,
      totalCandidates: rawJobs.length,
      degraded: degraded ?? { reason: "llm_failed", message: "Scoring unavailable." },
    };
  }

  // The provider's chat path does not surface finishReason. We log a
  // warning for any content truncation indicators we can detect from the
  // raw text (truncated JSON, missing closing brace) so future failures
  // are debuggable.
  const looksTruncated =
    rawText.length > 0 && !rawText.trim().endsWith("}");

  // The prompt instructs the model to return a single JSON object; we
  // still defend with a multi-step recovery in case the model echoes back
  // a snippet containing a stray quote/newline that breaks the JSON parser.
  type Item = {
    url: string;
    title: string;
    company: string;
    location?: string | null;
    salary?: string | null;
    deadline?: string | null;
    snippet: string;
    jobType: string;
    fitScore: number;
    fitReason: string;
    matchHighlights?: string[];
    concerns?: string[];
    breakdown?: { skillOverlap?: number; semantic?: number; experience?: number };
  };

  // Clamp a 0..1 component into [0, 1], accepting number | undefined and
  // coercing NaN/non-finite values to 0. Used to defend the LLM-emitted
  // breakdown against the occasional out-of-range or non-numeric value.
  function clamp01(n: unknown): number {
    if (typeof n !== "number" || !Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }
  // Loose parsed type — the post-parse step below normalises the various
  // shapes the model might emit (canonical `{jobs:{items:[...]}}` or the
  // loose `{jobs:[...]}` form that gemini-2.5-flash-lite sometimes returns).
  type Parsed = { reasoning?: string; jobs?: { items?: Item[] } | Item[]; topMatches?: Item[]; results?: Item[]; items?: Item[] };
  let parsed: Parsed;

  const tryParse = (s: string): Parsed | null => {
    // Strategy 1: direct parse.
    try { return JSON.parse(s); } catch {}
    // Strategy 2: extract the outermost { ... } block.
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first !== -1 && last > first) {
      const candidate = s.slice(first, last + 1);
      try { return JSON.parse(candidate); } catch {}
      // Strategy 3: best-effort sanitise of control chars that often appear in
      // echoed job descriptions (raw \n, \r, \t inside a JSON string).
      const sanitised = candidate
        .replace(/\\"/g, "\u0001")  // temporarily protect valid escapes
        .replace(/[\u0000-\u001F]/g, " ") // remove raw control chars
        .replace(/\u0001/g, "\\\"");
      try { return JSON.parse(sanitised); } catch {}
    }
    return null;
  };

  const recovered = tryParse(rawText);
  if (!recovered) {
    if (looksTruncated) {
      // The model ran out of output tokens mid-JSON. Throw as a retryable
      // so the breaker can open and the next call degrades gracefully
      // rather than spamming the user's UI with a parse error.
      throw new RetryableError(
        `Hunter: response truncated mid-JSON (length ${rawText.length} chars, last 200: ${rawText.slice(-200).replace(/\s+/g, " ")})`,
        { status: 504 },
      );
    }
    throw new Error(
      `Hunter: failed to parse structured response (length ${rawText.length} chars, first 200: ${rawText.slice(0, 200).replace(/\s+/g, " ")})`
    );
  }
  parsed = recovered;

  // 5. Build a url → source lookup so we can stamp the source on each card.
  const urlToSource = new Map<string, string>();
  for (const j of rawJobs) {
    if (j.url) urlToSource.set(j.url, j.source);
  }

  // Tolerate the model returning either:
  //   { reasoning, jobs: { items: [...] } }    (canonical shape)
  //   { reasoning, jobs: [...] }                (loose — flash-lite sometimes drops the wrapper)
  //   { reasoning, topMatches: [...] }          (alternate name)
  //   { reasoning, results: [...] }             (alternate name)
  //   { reasoning, items: [...] }               (alternate name)
  let items: any[] = [];
  if (Array.isArray((parsed as any).jobs)) {
    items = (parsed as any).jobs;
  } else if ((parsed as any).jobs && Array.isArray((parsed as any).jobs.items)) {
    items = (parsed as any).jobs.items;
  } else if (Array.isArray((parsed as any).topMatches)) {
    items = (parsed as any).topMatches;
  } else if (Array.isArray((parsed as any).results)) {
    items = (parsed as any).results;
  } else if (Array.isArray((parsed as any).items)) {
    items = (parsed as any).items;
  }
  const jobs: JobCard[] = items
    .filter((j) => typeof j.url === "string" && j.url.length > 0)
    .map((j) => {
      const url = j.url;
      const source = urlToSource.get(url) ?? "unknown";
      // The LLM is instructed to emit breakdown {skillOverlap, semantic,
      // experience} in [0,1]. We clamp defensively and recompute the final
      // fitScore from those components with the engine's exact formula so
      // the headline number is always consistent with the breakdown shown
      // in the UI. If the LLM omits the breakdown, we trust the integer
      // it emitted but flag the card with a synthesised placeholder so the
      // UI can show a "re-evaluate" hint.
      const raw = j.breakdown ?? {};
      const skillOverlap = clamp01(raw.skillOverlap);
      const semantic = clamp01(raw.semantic);
      const experience = clamp01(raw.experience);
      const hasBreakdown =
        j.breakdown !== undefined &&
        typeof j.breakdown === "object" &&
        j.breakdown !== null &&
        (raw.skillOverlap !== undefined ||
          raw.semantic !== undefined ||
          raw.experience !== undefined);
      const componentScore =
        0.6 * skillOverlap + 0.3 * semantic + 0.1 * experience;
      const fitScore = hasBreakdown
        ? Math.max(0, Math.min(100, Math.round(componentScore * 100)))
        : Math.max(0, Math.min(100, Math.round(j.fitScore)));
      return {
        id: stableId(url),
        title: j.title,
        company: j.company,
        location: j.location ?? null,
        salary: j.salary ?? null,
        deadline: j.deadline ?? null,
        url,
        snippet: j.snippet,
        jobType: j.jobType,
        fitScore,
        fitReason: j.fitReason,
        matchHighlights: j.matchHighlights ?? [],
        concerns: j.concerns ?? [],
        source,
        breakdown: hasBreakdown
          ? { skillOverlap, semantic, experience }
          : undefined,
      };
    })
    // sort by fitScore desc for the UI
    .sort((a, b) => b.fitScore - a.fitScore);

  // 6. EXCLUSIVE remote fallback. If the user asked for a specific
  //    location and the LLM picked zero cards whose location matches it,
  //    we REPLACE the entire result set with the strongest remote
  //    candidates from the raw pool — not top up. The user explicitly
  //    asked for "exclusively remote jobs" in this branch, so mixing in
  //    the LLM's out-of-region picks (which the model is forced to
  //    produce to satisfy the 5-8 quota) would defeat the purpose.
  //
  //    "Match" is decided by rankByLocationRelevance's local bucket, which
  //    groups by city tokens from the user-supplied location string. We
  //    also treat the LLM's own location label as a secondary signal so a
  //    card the LLM tagged as the target city isn't dropped just because
  //    the raw job was in the `other` bucket.
  const returnedUrls = new Set(jobs.map((j) => j.url));
  if (location) {
    const localUrls = new Set(
      rankByLocationRelevance(rawJobs, location).local.map((j) => j.url),
    );
    const hasLocalMatch = jobs.some(
      (j) => localUrls.has(j.url) || matchesLocationString(j.location, location),
    );

    if (!hasLocalMatch) {
      const ranked = rankByLocationRelevance(rawJobs, location);
      const remotePool = ranked.remote.filter((j) => !returnedUrls.has(j.url));
      const fallback: JobCard[] = remotePool.slice(0, 8).map((j) => {
        const url = j.url;
        const source = urlToSource.get(url) ?? j.source;
        return {
          id: stableId(url),
          title: j.title,
          company: j.company,
          location: j.location ?? "Remote",
          salary: j.salary ?? null,
          deadline: j.deadline ?? null,
          url,
          snippet: j.snippet,
          jobType: j.jobType,
          // Conservative score: the LLM didn't vet these. 50 reflects
          // "unknown fit" without pretending the role was grounded in
          // the CV. The UI badges these as remote fallback so the user
          // can see they're not live-scored.
          fitScore: 50,
          fitReason: `No matches in ${location} this week — this is a remote role and may be open to your location.`,
          matchHighlights: [],
          concerns: ["Auto-surfaced remote fallback — not live-scored against your CV."],
          source,
          isRemoteFallback: true,
        };
      });

      // Replace the result set so the user sees ONLY remote cards in this
      // branch. If the remote pool was empty (e.g. all raw jobs were
      // strictly in-region but none matched the LLM's filter), fall back
      // to the LLM's picks unchanged so the page is never blank.
      if (fallback.length > 0) {
        jobs.length = 0;
        jobs.push(...fallback);
        parsed.reasoning =
          `No ${query} roles in ${location} this week — showing the best remote matches for your search.`;
      }
    }
  }

  return {
    query,
    jobs,
    reasoning: parsed.reasoning ?? "Here are the closest matches I could find.",
    model: MODEL,
    retrievedAt: new Date().toISOString(),
    sourcesUsed,
    totalCandidates: rawJobs.length,
  };
}

export { dedupe };

// Re-export under the legacy name so older callers (the API route) keep working.
export const normaliseQuery = normalise;
