/**
 * Assistant agent — the intent router that powers Pillar 3.
 *
 * The chat route calls `runAssistant({ userId, message, history, intentHint })`.
 * It returns a structured `AssistantResponse` whose `mode` field tells the
 * client which renderer to use (chip results, chat text, structured card).
 *
 * Five modes:
 *
 *   - "readiness"    → user's overall readiness for a role they specify
 *                       (e.g. "am I ready for a Google SWE internship?")
 *                       Calls scoreFitScore(benchmarkKey=userRole).
 *
 *   - "gap_analysis" → "what am I missing for {role}?"  → fit-score with
 *                       strong emphasis on the `missing` list and a Gemini
 *                       plan to close the top 3 gaps.
 *
 *   - "roadmap"      → "build me a 6-week plan to become a {role}"  →
 *                       gap analysis + a Gemini-generated weekly plan.
 *
 *   - "cover_letter" → "draft a cover letter for {role} at {company}"  →
 *                       fit-score (for strengths to highlight) + Gemini
 *                       draft in the requested tone/length.
 *
 *   - "general"      → fallback: existing RAG chat with persona prompt.
 *
 * The specialised modes all share `scoreFitScore` as the scoring engine.
 * They differ only in (a) the system prompt and (b) the final Gemini call
 * that turns the structured score into the user-facing message.
 */

import { SchemaType, type Schema } from "@google/generative-ai";
import { chatComplete } from "@/lib/ai/provider";
import {
  scoreFitScore,
  type FitScoreResult,
  type ScoredSkill,
} from "@/lib/agents/fitScore";
import { BENCHMARKS, BENCHMARK_LIST, type RoleBenchmark } from "@/lib/data/benchmarks";
import { getOrSynthesiseBenchmark } from "@/lib/data/benchmarks/dynamic";
import { type Citation } from "@/lib/rag/retrieve-cv";

// ---------- Public types ----------

export type AssistantIntent =
  | "readiness"
  | "gap_analysis"
  | "roadmap"
  | "cover_letter"
  | "general";

export interface AssistantInput {
  userId: string;
  message: string;
  /** Recent chat turns (oldest first) for context in the general fallback. */
  history?: { role: "user" | "model"; content: string }[];
  /**
   * When set by a UI chip, skip classification and route directly to the
   * matching sub-agent. The chip also pre-fills any structured fields.
   */
  intentHint?: AssistantIntent;
  /** Optional structured inputs from a chip. */
  hints?: {
    benchmarkKey?: string;
    /**
     * Free-text role the user typed (e.g. "MLOps Engineer at a fintech").
     * If `benchmarkKey` doesn't match a static role, this is used to
     * synthesise a benchmark on the fly. Mutually exclusive with
     * `benchmark` — if both are set, `benchmark` wins.
     */
    role?: string;
    /** Pre-resolved benchmark; callers that already have one can pass it. */
    benchmark?: RoleBenchmark;
    weeks?: number;
    tone?: "professional" | "friendly" | "enthusiastic";
    company?: string;
  };
}

export type AssistantResponse =
  | {
      mode: "readiness";
      message: string;
      fitScore: FitScoreResult;
    }
  | {
      mode: "gap_analysis";
      message: string;
      fitScore: FitScoreResult;
    }
  | {
      mode: "roadmap";
      message: string;
      fitScore: FitScoreResult;
      weeks: number;
    }
  | {
      mode: "cover_letter";
      message: string;
      fitScore: FitScoreResult;
      tone: NonNullable<AssistantInput["hints"]>["tone"];
      company?: string;
    }
  | {
      mode: "general";
      message: string;
      citations: Citation[];
    };

// ---------- Intent classification ----------

const CLASSIFY_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    intent: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ["readiness", "gap_analysis", "roadmap", "cover_letter", "general"],
      description:
        "Classify the user's message into one of the five assistant modes.",
    },
    benchmarkKey: {
      type: SchemaType.STRING,
      description:
        "If the user names a role, return its benchmark key (e.g. 'data-engineer'). " +
        "If none of the benchmarks match, return ''.",
    },
    weeks: {
      type: SchemaType.INTEGER,
      description: "For roadmap mode, the number of weeks the user requested. Default 6.",
    },
    tone: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ["professional", "friendly", "enthusiastic"],
      description: "For cover-letter mode, the requested tone. Default professional.",
    },
    company: {
      type: SchemaType.STRING,
      description: "For cover-letter mode, the company name if mentioned.",
    },
  },
  required: ["intent"],
};

const BENCHMARK_HINT = BENCHMARK_LIST.map(
  (b) => `- ${b.key}: ${b.title} — ${b.summary}`,
).join("\n");

async function classifyIntent(
  message: string,
): Promise<{
  intent: AssistantIntent;
  benchmarkKey?: string;
  weeks?: number;
  tone?: NonNullable<AssistantInput["hints"]>["tone"];
  company?: string;
}> {
  const prompt =
    `Classify this message into one of the assistant modes.\n` +
    `Benchmarks available:\n${BENCHMARK_HINT}\n\n` +
    `User: ${message}\n`;
  try {
    const raw = await chatComplete([{ role: "user", parts: prompt }], {
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
        responseSchema: CLASSIFY_SCHEMA,
      },
    });
    const parsed = JSON.parse(raw) as {
      intent: AssistantIntent;
      benchmarkKey?: string;
      weeks?: number;
      tone?: NonNullable<AssistantInput["hints"]>["tone"];
      company?: string;
    };
    // Sanitise: only return a benchmark key that actually exists.
    const benchmarkKey =
      parsed.benchmarkKey && BENCHMARKS[parsed.benchmarkKey]
        ? parsed.benchmarkKey
        : undefined;
    return {
      intent: parsed.intent ?? "general",
      ...(benchmarkKey ? { benchmarkKey } : {}),
      weeks: typeof parsed.weeks === "number" ? Math.max(1, Math.min(52, parsed.weeks)) : undefined,
      tone: parsed.tone,
      company: parsed.company?.trim() || undefined,
    };
  } catch {
    return { intent: "general" };
  }
}

// ---------- Entity extraction helpers ----------

function pickBenchmarkKey(
  hint: AssistantInput["hints"] | undefined,
  classified: string | undefined,
): string | undefined {
  if (hint?.benchmarkKey && BENCHMARKS[hint.benchmarkKey]) return hint.benchmarkKey;
  if (classified && BENCHMARKS[classified]) return classified;
  return undefined;
}

/**
 * Resolve the benchmark for a specialised chip. Order of precedence:
 *   1. Inline `hints.benchmark` (caller already resolved it).
 *   2. Static `hints.benchmarkKey` (one of the 4 curated roles).
 *   3. Free-text `hints.role` — synthesise on the fly via Gemini.
 *   4. The classifier's `benchmarkKey` (if it matched a static role).
 * Returns null if none could be resolved; the caller should fall back
 * to general chat in that case.
 */
async function resolveBenchmark(
  userId: string,
  hints: AssistantInput["hints"] | undefined,
  classifiedKey: string | undefined,
): Promise<RoleBenchmark | null> {
  if (hints?.benchmark) return hints.benchmark;
  const key = pickBenchmarkKey(hints, classifiedKey);
  if (key) return BENCHMARKS[key] ?? null;
  if (hints?.role && hints.role.trim().length > 0) {
    try {
      return await getOrSynthesiseBenchmark(userId, hints.role);
    } catch (err) {
      // Synthesis failed — caller will fall back to general chat.
      console.warn("[assistant] dynamic benchmark synthesis failed", err);
      return null;
    }
  }
  return null;
}

function summariseFitScore(fit: FitScoreResult): string {
  const matched = fit.matched.map((m) => m.skill.label).join(", ") || "none";
  const missing = fit.missing.map((m) => m.skill.label).join(", ") || "none";
  return [
    `Score: ${fit.score}/100 (${fit.verdict})`,
    `Strengths: ${matched}`,
    `Gaps: ${missing}`,
    `Experience: ${fit.experience.inferredYears}y vs ${fit.experience.requiredYears}y required`,
    `Rationale: ${fit.rationale}`,
  ].join("\n");
}

// ---------- Sub-agent: readiness ----------

const READINESS_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    verdict: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ["ready_now", "ready_in_weeks", "not_yet"],
      description: "Honest verdict on the user's readiness.",
    },
    weeksToReady: {
      type: SchemaType.INTEGER,
      description: "Estimated weeks until the user is competitive.",
    },
    headline: {
      type: SchemaType.STRING,
      description: "One bold sentence summarising the verdict.",
    },
    nextAction: {
      type: SchemaType.STRING,
      description: "The single most impactful next action.",
    },
  },
  required: ["verdict", "headline", "nextAction"],
};

async function runReadiness(
  userId: string,
  benchmark: RoleBenchmark,
  message: string,
): Promise<AssistantResponse & { mode: "readiness" }> {
  const fit = await scoreFitScore({ userId, benchmark });
  const raw = await chatComplete(
    [{ role: "user", parts:
      `The user asks: "${message}"\n\n` +
      `Role: ${benchmark.title} (${benchmark.summary})\n` +
      `Fit-score summary:\n${summariseFitScore(fit)}`,
    }],
    {
      tier: "quality",
      systemInstruction:
        "You are a sharp, action-oriented career coach. " +
        "Be honest about readiness — do not flatter. " +
        "Use the fit-score data verbatim where helpful. " +
        "If the user is not yet ready, name the top blocker and a concrete next step. " +
        "Return only the JSON described in the schema.",
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
        responseSchema: READINESS_SCHEMA,
      },
    },
  );
  const parsed = JSON.parse(raw) as {
    verdict: "ready_now" | "ready_in_weeks" | "not_yet";
    weeksToReady?: number;
    headline: string;
    nextAction: string;
  };
  const messageText =
    `**${parsed.headline}**\n\n` +
    `Verdict: ${parsed.verdict.replace("_", " ")}` +
    (parsed.weeksToReady ? ` · ~${parsed.weeksToReady} weeks to ready` : "") +
    `\n\n**Next action:** ${parsed.nextAction}`;
  return { mode: "readiness", message: messageText, fitScore: fit };
}

// ---------- Sub-agent: gap analysis ----------

const GAP_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING, description: "One-line summary of the gap." },
    topGaps: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "Top 3-5 skills to close, most impactful first.",
    },
    actions: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "Concrete actions per gap (1-2 each).",
    },
  },
  required: ["summary", "topGaps", "actions"],
};

async function runGapAnalysis(
  userId: string,
  benchmark: RoleBenchmark,
  message: string,
): Promise<AssistantResponse & { mode: "gap_analysis" }> {
  const fit = await scoreFitScore({ userId, benchmark });
  const raw = await chatComplete(
    [{ role: "user", parts:
      `The user asks: "${message}"\n\n` +
      `Role: ${benchmark.title} (${benchmark.summary})\n` +
      `Fit-score summary:\n${summariseFitScore(fit)}\n\n` +
      `Focus on the missing must-have skills. Return JSON.`,
    }],
    {
      tier: "quality",
      systemInstruction:
        "You are a pragmatic career coach. " +
        "Identify the top 3-5 skills the user must close to become competitive. " +
        "Pair each gap with a concrete action (course, project, cert). " +
        "Be specific — no fluff like 'learn more about X'.",
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 700,
        responseMimeType: "application/json",
        responseSchema: GAP_SCHEMA,
      },
    },
  );
  const parsed = JSON.parse(raw) as { summary: string; topGaps: string[]; actions: string[] };
  const text =
    `**${parsed.summary}**\n\n` +
    `**Top gaps to close:**\n` +
    parsed.topGaps.map((g, i) => `${i + 1}. ${g}`).join("\n") +
    `\n\n**How to close them:**\n` +
    parsed.actions.map((a, i) => `${i + 1}. ${a}`).join("\n") +
    `\n\n*Fit score: ${fit.score}/100 — ${fit.verdict}*`;
  return { mode: "gap_analysis", message: text, fitScore: fit };
}

// ---------- Sub-agent: roadmap ----------

const ROADMAP_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    overview: { type: SchemaType.STRING, description: "One-sentence plan overview." },
    weeks: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          week: { type: SchemaType.INTEGER },
          theme: { type: SchemaType.STRING },
          deliverables: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          hours: { type: SchemaType.INTEGER, description: "Suggested weekly hours." },
        },
        required: ["week", "theme", "deliverables", "hours"],
      },
    },
  },
  required: ["overview", "weeks"],
};

async function runRoadmap(
  userId: string,
  benchmark: RoleBenchmark,
  weeks: number,
  message: string,
): Promise<AssistantResponse & { mode: "roadmap" }> {
  const fit = await scoreFitScore({ userId, benchmark });
  const raw = await chatComplete(
    [{ role: "user", parts:
      `The user asks: "${message}"\n\n` +
      `Role: ${benchmark.title}\n` +
      `Plan length: ${weeks} weeks\n` +
      `Missing must-haves: ${fit.missing.map((m: ScoredSkill) => m.skill.label).join(", ")}\n` +
      `Existing strengths: ${fit.matched.map((m: ScoredSkill) => m.skill.label).join(", ")}\n\n` +
      `Build a ${weeks}-week plan that closes the top gaps first, then layers on nice-to-haves.`,
    }],
    {
      tier: "quality",
      systemInstruction:
        "You are a focused learning-path designer. " +
        "Front-load the highest-impact skills from the gap list. " +
        "Each week must have a clear theme, 2-3 concrete deliverables " +
        "(a project, a course module, a portfolio piece), and a realistic " +
        "weekly hours target (5-15). Return JSON.",
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: 1400,
        responseMimeType: "application/json",
        responseSchema: ROADMAP_SCHEMA,
      },
    },
  );
  const parsed = JSON.parse(raw) as {
    overview: string;
    weeks: { week: number; theme: string; deliverables: string[]; hours: number }[];
  };
  const text =
    `**${parsed.overview}**\n\n` +
    parsed.weeks
      .map(
        (w) =>
          `**Week ${w.week} — ${w.theme}** (${w.hours}h)\n` +
          w.deliverables.map((d) => `  - ${d}`).join("\n"),
      )
      .join("\n\n") +
    `\n\n*Target role: ${benchmark.title} · Starting fit: ${fit.score}/100*`;
  return { mode: "roadmap", message: text, fitScore: fit, weeks };
}

// ---------- Sub-agent: cover letter ----------

const COVER_LETTER_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    subject: { type: SchemaType.STRING },
    body: { type: SchemaType.STRING, description: "Plain-text cover letter, ~250-350 words." },
  },
  required: ["subject", "body"],
};

async function runCoverLetter(
  userId: string,
  benchmark: RoleBenchmark,
  tone: NonNullable<AssistantInput["hints"]>["tone"],
  company: string | undefined,
  message: string,
): Promise<AssistantResponse & { mode: "cover_letter" }> {
  const fit = await scoreFitScore({ userId, benchmark });
  const companyLine = company ? `Target company: ${company}\n` : "";
  // Target word count is intentional — keeps the model focused and avoids
  // silent truncation. 1200 tokens is enough headroom for a 320-word letter
  // plus JSON wrapping and the subject line, even with marker bloat.
  const WORD_TARGET = 320;
  const raw = await chatComplete(
    [{ role: "user", parts:
      `The user asks: "${message}"\n\n` +
      `Role: ${benchmark.title} (${benchmark.summary})\n` +
      `${companyLine}` +
      `Tone: ${tone}\n` +
      `Strengths to lead with: ${fit.matched.slice(0, 5).map((m) => m.skill.label).join(", ")}\n` +
      `Experience: ${fit.experience.inferredYears}y\n` +
      `Rationale: ${fit.rationale}\n\n` +
      `Write a ${tone} cover letter, exactly ~${WORD_TARGET} words (range 280-340). ` +
      `Open with a specific, non-generic hook tied to the role or company. ` +
      `Lead with the user's top strengths. Do NOT mention the fit score. ` +
      `End with a confident, specific sign-off (no placeholder placeholders).`,
    }],
    {
      tier: "quality",
      systemInstruction:
        "You write cover letters that don't sound like cover letters. " +
        "Avoid clichés ('I am writing to apply', 'passionate about', 'I would be a great fit'). " +
        "Use the user's strengths as concrete evidence. " +
        `Hit approximately ${WORD_TARGET} words. Finish every sentence — never stop mid-thought.`,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1200,
        responseMimeType: "application/json",
        responseSchema: COVER_LETTER_SCHEMA,
      },
    },
  );
  const parsed = JSON.parse(raw) as { subject: string; body: string };
  // Sanity-check: if the model came back with a letter that ends mid-sentence
  // (no terminal punctuation, last word clipped) we surface a soft warning in
  // the persisted message so the UI can hint at a retry.
  const body = parsed.body?.trim() ?? "";
  const endsCleanly = /[.!?\"]\s*$/.test(body);
  const warning = endsCleanly
    ? ""
    : "\n\n*(This draft may be truncated. Click Run again to regenerate.)*";
  const text = `**Subject:** ${parsed.subject}\n\n${body}${warning}`;
  return {
    mode: "cover_letter",
    message: text,
    fitScore: fit,
    tone,
    ...(company ? { company } : {}),
  };
}

// ---------- Sub-agent: general chat (RAG fallback) ----------

async function runGeneralChat(
  userId: string,
  message: string,
  history: AssistantInput["history"],
  retrieveCvChunks: (userId: string, query: string) => Promise<Citation[]>,
): Promise<AssistantResponse & { mode: "general" }> {
  const citations = await retrieveCvChunks(userId, message);
  // We hand the model a SHORT, section-labelled index of relevant
  // chunks, not the full chunk text. The model uses the section label
  // to ground its reply ("Your Technical Skills section shows…") and
  // appends a [chunk-id] marker wherever a claim is anchored to that
  // chunk. The chat UI turns those markers into clickable chips.
  // Showing the model the raw text caused it to copy-paste long
  // passages of the CV into the user-facing reply — that's noise the
  // user already has in their own CV; what they want is a coach's
  // take, not a re-print.
  const ctxIndex = citations
    .map((c) => `- ${c.source}  →  [${c.id}]`)
    .join("\n");
  const messages = [
    ...(history ?? []).map((h) => ({ role: h.role, parts: h.content })),
    {
      role: "user" as const,
      parts:
        (ctxIndex ? `Relevant CV sections (use these to ground your reply; do NOT quote them verbatim):\n${ctxIndex}\n\n` : "") +
        `User: ${message}\n\n` +
        "Reply in 120 words or fewer. Be direct and conversational. " +
        "Anchor specific claims to the matching chunk by writing [chunk-id] right after the claim. " +
        "Do not list every section — only cite the ones that actually support what you're saying.",
    },
  ];
  const reply = await chatComplete(messages, {
    systemInstruction:
      "You are a sharp, action-oriented career coach. " +
      "You have already read the user's CV — speak from memory, do not paste it back. " +
      "Stay under 120 words unless the user explicitly asks for detail. " +
      "Anchor claims to the relevant CV section with a [chunk-id] marker, " +
      "for example: \"Your experience leading payments at scale [chunk-id] is exactly what Stripe looks for.\" " +
      "Only cite chunks that genuinely support the claim — never decorate prose with markers for the sake of it.",
    generationConfig: { temperature: 0.6, maxOutputTokens: 400 },
  });
  return { mode: "general", message: reply, citations };
}

// ---------- Main entry point ----------

export async function runAssistant(
  input: AssistantInput,
  retrieveCvChunks: (userId: string, query: string) => Promise<Citation[]>,
): Promise<AssistantResponse> {
  const { userId, message, history, intentHint, hints } = input;

  // Resolve intent + structured fields.
  let intent: AssistantIntent = intentHint ?? "general";
  let classifiedKey: string | undefined;
  let weeks = hints?.weeks ?? 6;
  let tone = hints?.tone ?? "professional";
  let company: string | undefined = hints?.company;

  if (!intentHint) {
    const classified = await classifyIntent(message);
    intent = classified.intent;
    classifiedKey = classified.benchmarkKey;
    if (classified.weeks) weeks = classified.weeks;
    if (classified.tone) tone = classified.tone;
    if (classified.company) company = classified.company;
  }

  // General chat — no benchmark needed.
  if (intent === "general") {
    return runGeneralChat(userId, message, history, retrieveCvChunks);
  }

  // Specialised modes need a benchmark. Resolution chain (in order):
  //   inline > static key > synthesise from free-text role.
  const benchmark = await resolveBenchmark(userId, hints, classifiedKey);
  if (!benchmark) {
    return runGeneralChat(userId, message, history, retrieveCvChunks);
  }

  return dispatchSpecialised(
    userId, message, benchmark, weeks, tone, company, retrieveCvChunks,
  );
}

function dispatchSpecialised(
  userId: string,
  message: string,
  benchmark: RoleBenchmark,
  weeks: number,
  tone: NonNullable<AssistantInput["hints"]>["tone"],
  company: string | undefined,
  retrieveCvChunks: (userId: string, query: string) => Promise<Citation[]>,
): Promise<AssistantResponse> {
  switch (true) {
    case message.toLowerCase().includes("roadmap") ||
         message.toLowerCase().includes("plan") ||
         message.toLowerCase().includes("week"):
      return runRoadmap(userId, benchmark, weeks, message);
    case message.toLowerCase().includes("cover letter"):
      return runCoverLetter(userId, benchmark, tone, company, message);
    case message.toLowerCase().includes("gap") ||
         message.toLowerCase().includes("missing"):
      return runGapAnalysis(userId, benchmark, message);
    default:
      return runReadiness(userId, benchmark, message);
  }
}
