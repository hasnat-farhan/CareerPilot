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

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retrieveCvChunks } from "@/lib/rag/retrieve-cv";
import { fanOutSearch, dedupe } from "@/lib/agents/sources";
import { withBackoff, geminiBreaker, RetryableError } from "@/lib/ai/resilience";
import { scoreFitScore } from "@/lib/agents/fitScore";

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

const MODEL = "gemini-2.5-flash";
const MAX_RAW_FOR_LLM = 25; // cap to keep prompt size sane

const HUNTER_OUTPUT_SCHEMA: import("@google/generative-ai").Schema = {
  type: SchemaType.OBJECT,
  properties: {
    reasoning: {
      type: SchemaType.STRING,
      description:
        "One or two sentences summarising the search strategy and the overall quality of the matches for this user.",
    },
    jobs: {
      type: SchemaType.OBJECT,
      properties: {
        items: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              url:              { type: SchemaType.STRING, description: "Must match one of the URLs in the input rawListings." },
              title:            { type: SchemaType.STRING },
              company:          { type: SchemaType.STRING },
              location:         { type: SchemaType.STRING,  nullable: true },
              salary:           { type: SchemaType.STRING,  nullable: true },
              deadline:         { type: SchemaType.STRING,  nullable: true },
              snippet:          { type: SchemaType.STRING, description: "1-3 sentence teaser, may be copied from the source snippet." },
              jobType:          { type: SchemaType.STRING, description: "internship | full-time | contract | part-time | research | other" },
              fitScore:         { type: SchemaType.INTEGER, description: "0-100 integer." },
              fitReason:        { type: SchemaType.STRING },
              matchHighlights:  { type: SchemaType.ARRAY, items: { type: SchemaType.STRING, nullable: true } },
              concerns:         { type: SchemaType.ARRAY, items: { type: SchemaType.STRING, nullable: true } },
            },
            required: ["url", "title", "company", "snippet", "jobType", "fitScore", "fitReason", "matchHighlights", "concerns"],
          },
        },
      },
      required: ["items"],
    },
  },
  required: ["reasoning", "jobs"],
};

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

async function getClient(): Promise<GoogleGenerativeAI> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  return new GoogleGenerativeAI(key);
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
    "Respond with a single JSON object matching the required schema. No prose outside JSON.",
  ].join("\n");
}

// ---------- main entrypoint ----------

/**
 * Make a single Gemini call for the scoring+structuring step. Kept as its
 * own function so the breaker + backoff wrappers in runHunter can call it
 * uniformly — the throw-or-succeed contract is what those wrappers depend on.
 *
 * Errors are passed through untouched; the resilience layer classifies them
 * (see isRateLimitError in lib/ai/resilience.ts).
 */
async function callGemini(
  query: string,
  rawJobs: Awaited<ReturnType<typeof fanOutSearch>>,
  cvContext: string,
) {
  const genai = await getClient();
  const model = genai.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      temperature: 0.2,
      // 8192 gives 8 job cards × (multi-sentence fitReason + 3-5 highlights +
      // 1-3 concerns) plenty of room. We hit MAX_TOKENS at 6000 with a
      // response of 6234 chars, so 8192 is the next safe step.
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      responseSchema: HUNTER_OUTPUT_SCHEMA,
    },
  });

  return model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: buildScoringPrompt(query, rawToPromptBlock(rawJobs), cvContext) }],
      },
    ],
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

  // 4. One Gemini call to score + structure the picked subset. The call is
  //    guarded by (a) an in-memory circuit breaker keyed on "gemini" and
  //    (b) exponential backoff with full jitter. If the breaker is OPEN we
  //    skip the call entirely and return a degraded raw-listing result; if
  //    retries are exhausted we do the same. Either way the route still
  //    gets a payload to persist + return so the user sees something.
  const breaker = geminiBreaker();

  let structRes: Awaited<ReturnType<typeof callGemini>> | null = null;
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
      structRes = await breaker.run(() =>
        withBackoff(() => callGemini(query, rawJobs, cvContext), {
          maxAttempts: 3,
          baseMs: 500,
          capMs: 8_000,
        }),
      );
    } catch (err) {
      if (err instanceof RetryableError) {
        // Retries exhausted on rate-limit, OR circuit opened mid-call.
        console.warn(`[hunter] gemini call failed after backoff: ${err.message}`);
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

  // 4b. Degraded path: turn the raw jobs into JobCards. We still run the
  //     deterministic scorer per job so the user gets real fit numbers
  //     (the LLM is the thing that's paused, not the embed/RPC). If the
  //     per-call scorer also fails we fall back to 50. Pick the top 8 by
  //     source order (already a best-effort ranking).
  if (!structRes) {
    const fallbackRaw = rawJobs.slice(0, 8);
    const fallbackDet: { score: number | null; verdict: string | null }[] = await Promise.all(
      fallbackRaw.map(async (j) => {
        const jd = [
          `Query: ${query}`,
          `Title: ${j.title}`,
          `Company: ${j.company}`,
          j.location ? `Location: ${j.location}` : "",
          j.salary ? `Salary: ${j.salary}` : "",
          j.snippet,
        ]
          .filter(Boolean)
          .join("\n");
        try {
          const res = await scoreFitScore({ userId, jd });
          return { score: res.score, verdict: res.verdict };
        } catch (err) {
          console.warn(`[hunter-degraded] scoreFitScore failed for ${j.url}: ${(err as Error).message}`);
          return { score: null, verdict: null };
        }
      }),
    );
    const fallbackCards: JobCard[] = fallbackRaw.map((j, idx) => {
      const { score, verdict } = fallbackDet[idx] ?? { score: null, verdict: null };
      const det = score !== null;
      const tag = det && verdict ? `${verdict} match (${score}/100)` : "";
      return {
        id: stableId(j.url),
        title: j.title,
        company: j.company,
        location: j.location,
        salary: j.salary,
        deadline: j.deadline,
        url: j.url,
        snippet: j.snippet,
        jobType: j.jobType,
        fitScore: score ?? 50,
        fitReason: det
          ? "Live narrative scoring is paused; the fit number is deterministic."
          : "Live scoring is paused — showing the raw match.",
        matchHighlights: tag ? [tag] : [],
        concerns: [],
        source: j.source,
      };
    });
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

  // Surface truncation in our error path so future failures are debuggable.
  const finishReason = structRes.response.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    console.warn(`[hunter] non-stop finishReason: ${finishReason}`);
  }

  // The schema guarantees JSON; we still defend with a multi-step recovery in
  // case Gemini returns an empty / partial body, or the model echoes back a
  // snippet containing a stray quote/newline that breaks the JSON parser.
  type Item = { url: string; title: string; company: string; location?: string | null; salary?: string | null; deadline?: string | null; snippet: string; jobType: string; fitScore: number; fitReason: string; matchHighlights?: string[]; concerns?: string[] };
  let parsed: { reasoning: string; jobs: { items: Item[] } };

  const rawText = structRes.response.text();
  const tryParse = (s: string): { reasoning: string; jobs: { items: Item[] } } | null => {
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
    throw new Error(
      `Hunter: failed to parse structured response (finishReason=${finishReason ?? "?"}, length ${rawText.length} chars, first 200: ${rawText.slice(0, 200).replace(/\s+/g, " ")})`
    );
  }
  parsed = recovered;

  // 5. Build a url → source lookup so we can stamp the source on each card.
  const urlToSource = new Map<string, string>();
  for (const j of rawJobs) {
    if (j.url) urlToSource.set(j.url, j.source);
  }

  const items = parsed.jobs?.items ?? [];

  // Deterministic fit-score pass. The RAG reminder is explicit: the user's
  // actual CV is the single source of truth. Gemini's score is LLM-mediated
  // and can drift; the deterministic scorer (skill overlap + semantic
  // cosine + experience/education) is grounded in the retrieved CV chunks.
  // We run all calls in parallel; per-item failure falls back to the LLM
  // score so a single embed/RPC blip doesn't blank out the list.
  const filtered = items.filter((j) => typeof j.url === "string" && j.url.length > 0);
  type DetRow = {
    llmScore: number;
    detScore: number | null;
    verdict: "strong" | "good" | "borderline" | "weak" | null;
  };
  const deterministicScores: DetRow[] = await Promise.all(
    filtered.map(async (j): Promise<DetRow> => {
      // Reconstruct a short JD from the fields we have. The deterministic
      // scorer is robust to short text — semantic is a cosine sim and skill
      // extraction is per-token. We include the original query so role
      // intent (e.g. "senior") is part of the comparison.
      const jd = [
        `Query: ${query}`,
        `Title: ${j.title}`,
        `Company: ${j.company}`,
        j.location ? `Location: ${j.location}` : "",
        j.salary ? `Salary: ${j.salary}` : "",
        j.snippet,
      ]
        .filter(Boolean)
        .join("\n");
      try {
        const res = await scoreFitScore({ userId, jd });
        return { llmScore: j.fitScore, detScore: res.score, verdict: res.verdict };
      } catch (err) {
        console.warn(`[hunter] scoreFitScore failed for ${j.url}: ${(err as Error).message}`);
        return { llmScore: j.fitScore, detScore: null, verdict: null };
      }
    }),
  );

  const jobs: JobCard[] = filtered
    .map((j, idx) => {
      const url = j.url;
      const source = urlToSource.get(url) ?? "unknown";
      // Promise.all preserves order & length, but TS can't see the
      // correlation. The default-{} keeps us robust to any future shape
      // change in DetRow.
      const { llmScore, detScore, verdict } = deterministicScores[idx] ?? {
        llmScore: j.fitScore,
        detScore: null,
        verdict: null,
      };
      // Deterministic wins when available. Otherwise keep the LLM number.
      const finalScore =
        detScore !== null ? detScore : Math.max(0, Math.min(100, Math.round(llmScore)));
      // Surface the verdict band as an extra highlight so the user can
      // see at a glance that the number is grounded (e.g. "Strong match —
      // 82/100"). The LLM's narrative fitReason is still the headline.
      const verdictTag = detScore !== null && verdict ? `${verdict} match (${detScore}/100)` : "";
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
        fitScore: finalScore,
        fitReason: j.fitReason,
        matchHighlights: verdictTag
          ? [verdictTag, ...(j.matchHighlights ?? [])]
          : j.matchHighlights ?? [],
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
