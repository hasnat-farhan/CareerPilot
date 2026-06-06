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
import { fanOutSearch, dedupe } from "@/lib/agents/sources";
import { withBackoff, geminiBreaker, RetryableError } from "@/lib/ai/resilience";
import { chatComplete } from "@/lib/ai/provider";

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
  fitScore: number;      // 0..100
  fitReason: string;     // 1-2 sentence justification grounded in CV
  matchHighlights: string[]; // bullet-list of CV attributes that matched
  concerns: string[];        // bullet-list of CV-vs-job mismatches
  source: string;        // which source produced this job
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

function rawToPromptBlock(raw: Awaited<ReturnType<typeof fanOutSearch>>): string {
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

function buildScoringPrompt(query: string, rawBlock: string, cvContext: string): string {
  return [
    "You are the Job Hunter agent for CareerPilot.",
    "",
    "USER QUERY:",
    query.trim(),
    "",
    cvContext
      ? "USER CV HIGHLIGHTS:\n" + cvContext
      : "USER CV HIGHLIGHTS: none available — score fit generically against the role described in the query.",
    "",
    "RAW JOB LISTINGS (each was already deduped across multiple job-board sources; you may pick up to 8):",
    "<<<",
    rawBlock,
    ">>>",
    "",
    "Your job:",
    "  1. Pick the 5-8 best-matching listings from the RAW block.",
    "  2. For each, score fit (0-100) AGAINST THE USER CV — penalise skill gaps, seniority mismatches, and visa/location friction; reward exact skill + experience alignment.",
    "  3. Write a 1-2 sentence fitReason citing specific CV evidence (or 'no CV available' if the CV block was empty).",
    "  4. Provide matchHighlights (CV attributes that match) and concerns (mismatches or risks), each 1 short sentence.",
    "",
    "Strict rules:",
    "  - url MUST be copied verbatim from one of the numbered listings above. Do not invent URLs.",
    "  - jobType must be one of: internship, full-time, contract, part-time, research, other.",
    "  - deadline is an ISO date (yyyy-mm-dd) or null.",
    "  - fitScore is an INTEGER in [0, 100].",
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
    '        "fitScore": <0-100 int>, "fitReason": "..."',
    '        "matchHighlights": ["..."], "concerns": ["..."] }',
    '    ] }',
    '  }',
  ].join("\n");
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
  rawJobs: Awaited<ReturnType<typeof fanOutSearch>>,
  cvContext: string,
): Promise<string> {
  const prompt = buildScoringPrompt(query, rawToPromptBlock(rawJobs), cvContext);
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

export async function runHunter(userId: string, query: string): Promise<HunterResult> {
  if (!query.trim()) throw new Error("Query is empty");

  // 1. Fan out to all sources in parallel.
  const rawJobs = await fanOutSearch(query);
  const sourcesUsed = Array.from(new Set(rawJobs.map((j) => j.source)));

  // 2. CV context (RAG seam — returns [] for now, the prompt tolerates it).
  const cvChunks = await retrieveCvChunks(userId, query);
  const cvContext = summariseCv(cvChunks);

  // 3. If we got zero results from every source, short-circuit gracefully.
  if (rawJobs.length === 0) {
    return {
      query,
      jobs: [],
      reasoning:
        "I could not find any current postings for that query across the configured job-board sources. Try a broader role term or a different location.",
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
      rawText = await breaker.run(() => callGemini(query, rawJobs, cvContext));
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
  type Item = { url: string; title: string; company: string; location?: string | null; salary?: string | null; deadline?: string | null; snippet: string; jobType: string; fitScore: number; fitReason: string; matchHighlights?: string[]; concerns?: string[] };
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
        fitScore: Math.max(0, Math.min(100, Math.round(j.fitScore))),
        fitReason: j.fitReason,
        matchHighlights: j.matchHighlights ?? [],
        concerns: j.concerns ?? [],
        source,
      };
    })
    // sort by fitScore desc for the UI
    .sort((a, b) => b.fitScore - a.fitScore);

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
