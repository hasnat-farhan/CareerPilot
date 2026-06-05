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
      citations: { id: string; source: string; text: string; score: number }[];
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
  const fit = await scoreFitScore({ userId, benchmarkKey: benchmark.key });
  const raw = await chatComplete(
    [{ role: "user", parts:
      `The user asks: "${message}"\n\n` +
      `Role: ${benchmark.title} (${benchmark.summary})\n` +
      `Fit-score summary:\n${summariseFitScore(fit)}`,
    }],
    {
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
  const fit = await scoreFitScore({ userId, benchmarkKey: benchmark.key });
  const raw = await chatComplete(
    [{ role: "user", parts:
      `The user asks: "${message}"\n\n` +
      `Role: ${benchmark.title} (${benchmark.summary})\n` +
      `Fit-score summary:\n${summariseFitScore(fit)}\n\n` +
      `Focus on the missing must-have skills. Return JSON.`,
    }],
    {
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
  const fit = await scoreFitScore({ userId, benchmarkKey: benchmark.key });
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
  const fit = await scoreFitScore({ userId, benchmarkKey: benchmark.key });
  const companyLine = company ? `Target company: ${company}\n` : "";
  const raw = await chatComplete(
    [{ role: "user", parts:
      `The user asks: "${message}"\n\n` +
      `Role: ${benchmark.title} (${benchmark.summary})\n` +
      `${companyLine}` +
      `Tone: ${tone}\n` +
      `Strengths to lead with: ${fit.matched.slice(0, 5).map((m) => m.skill.label).join(", ")}\n` +
      `Experience: ${fit.experience.inferredYears}y\n` +
      `Rationale: ${fit.rationale}\n\n` +
      `Write a ${tone} cover letter, 250-350 words. Open with a specific, non-generic hook. ` +
      `Lead with the user's top strengths. Do NOT mention the fit score.`,
    }],
    {
      systemInstruction:
        "You write cover letters that don't sound like cover letters. " +
        "Avoid clichés ('I am writing to apply', 'passionate about'). " +
        "Use the user's strengths as evidence. Keep it under 350 words.",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 900,
        responseMimeType: "application/json",
        responseSchema: COVER_LETTER_SCHEMA,
      },
    },
  );
  const parsed = JSON.parse(raw) as { subject: string; body: string };
  const text = `**Subject:** ${parsed.subject}\n\n${parsed.body}`;
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
  retrieveCvChunks: (userId: string, query: string) => Promise<
    { id: string; source: string; text: string; score: number }[]
  >,
): Promise<AssistantResponse & { mode: "general" }> {
  const citations = await retrieveCvChunks(userId, message);
  const ctxLines = citations
    .map((c) => `[${c.id}] ${c.source}: ${c.text}`)
    .join("\n\n");
  const messages = [
    ...(history ?? []).map((h) => ({ role: h.role, parts: h.content })),
    {
      role: "user" as const,
      parts:
        (ctxLines ? `CV context:\n${ctxLines}\n\n` : "") +
        `User: ${message}\n\n` +
        "Reply in 200 words or fewer. Cite CV chunks as [chunk-id] where relevant.",
    },
  ];
  const reply = await chatComplete(messages, {
    systemInstruction:
      "You are a sharp, action-oriented career coach. " +
      "Stay under 200 words unless the user explicitly asks for detail. " +
      "Cite CV chunks inline as [chunk-id].",
    generationConfig: { temperature: 0.6, maxOutputTokens: 600 },
  });
  return { mode: "general", message: reply, citations };
}

// ---------- Main entry point ----------

export async function runAssistant(
  input: AssistantInput,
  retrieveCvChunks: (
    userId: string,
    query: string,
  ) => Promise<{ id: string; source: string; text: string; score: number }[]>,
): Promise<AssistantResponse> {
  const { userId, message, history, intentHint, hints } = input;

  // Resolve intent + structured fields.
  let intent: AssistantIntent = intentHint ?? "general";
  let benchmarkKey: string | undefined;
  let weeks = hints?.weeks ?? 6;
  let tone = hints?.tone ?? "professional";
  let company: string | undefined = hints?.company;

  if (!intentHint) {
    const classified = await classifyIntent(message);
    intent = classified.intent;
    benchmarkKey = classified.benchmarkKey;
    if (classified.weeks) weeks = classified.weeks;
    if (classified.tone) tone = classified.tone;
    if (classified.company) company = classified.company;
  } else {
    benchmarkKey = pickBenchmarkKey(hints, hints?.benchmarkKey);
  }

  // Specialised modes need a benchmark. If we couldn't resolve one, fall
  // back to general chat (with a soft hint in the message).
  const benchmark = benchmarkKey ? BENCHMARKS[benchmarkKey] : undefined;
  if (intent !== "general" && !benchmark) {
    // Try one more thing: ask the classifier to extract a benchmark.
    if (!intentHint) {
      const fallback = await classifyIntent(message + " role:data-engineer");
      if (fallback.benchmarkKey && BENCHMARKS[fallback.benchmarkKey]) {
        return dispatchSpecialised(
          userId, message, fallback.benchmarkKey, weeks, tone, company,
          retrieveCvChunks,
        );
      }
    }
    return runGeneralChat(userId, message, history, retrieveCvChunks);
  }

  if (intent === "general" || !benchmark) {
    return runGeneralChat(userId, message, history, retrieveCvChunks);
  }

  return dispatchSpecialised(
    userId, message, benchmark.key, weeks, tone, company, retrieveCvChunks,
  );
}

function dispatchSpecialised(
  userId: string,
  message: string,
  benchmarkKey: string,
  weeks: number,
  tone: NonNullable<AssistantInput["hints"]>["tone"],
  company: string | undefined,
  retrieveCvChunks: (
    userId: string,
    query: string,
  ) => Promise<{ id: string; source: string; text: string; score: number }[]>,
): Promise<AssistantResponse> {
  const benchmark = BENCHMARKS[benchmarkKey]!;
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
