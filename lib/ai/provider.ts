/**
 * Google Gemini AI provider for CareerPilot.
 *
 * Single source of truth for every LLM and embedding call in the app.
 * Swap out this file to switch providers (OpenAI, Anthropic, etc.) without
 * touching downstream code in `lib/ai/embeddings.ts`, `lib/cv/ingester.ts`,
 * or the agent modules.
 *
 * Models used:
 *   - Embeddings:  gemini-embedding-2  (3072-dim, current GA embedding model)
 *   - Chat:        routed through `lib/ai/models.ts` — quality tier for the
 *                  four chip sub-agents, economy tier for the classifier,
 *                  dynamic benchmark synthesis, and general chat.
 *
 * Auth:
 *   The SDK constructor accepts a raw string API key. The actual value can be
 *   set under either the canonical name (GEMINI_API_KEY) or the legacy
 *   misspelled name (Gemini_API_Key) that ships in some local .env files.
 *   We standardise on the canonical name in code, but tolerate the legacy
 *   one so a freshly-cloned repo with a stale .env.local still boots.
 *
 * Rate-limit posture (demo tier):
 *   - We do NOT impose our own per-process rate limit on chat or embeddings.
 *     The free Gemini tier is generous enough for demo usage and our own
 *     limiter was throttling legitimate clicks.
 *   - We DO keep the circuit breaker + exponential backoff in
 *     `lib/ai/resilience.ts` as a safety net. If Gemini ever returns 429 or
 *     RESOURCE_EXHAUSTED we retry with jitter; if the failures cluster, the
 *     breaker opens for a short cooldown and we surface a clear error to the
 *     caller. This is per-process state, not a quota enforcer.
 */

import {
  GoogleGenerativeAI,
  TaskType,
  type Content,
  type GenerationConfig,
  type Part,
  type Tool as GeminiTool,
} from "@google/generative-ai";
import {
  geminiBreaker,
  withBackoff,
  isRateLimitError,
  RetryableError,
} from "@/lib/ai/resilience";
import { pickModel, nextModel, type ModelTier } from "@/lib/ai/models";

// ---------- Configuration ----------

const DEFAULT_EMBED_MODEL = "gemini-embedding-2";
const DEFAULT_CHAT_TIER: ModelTier = "economy";

/** gemini-embedding-2 returns 3072-dim vectors. */
const EMBEDDING_DIM = 3072;

function resolveApiKey(): string {
  const key = process.env.GEMINI_API_KEY ?? process.env.Gemini_API_Key;
  if (!key) {
    throw new Error(
      "[ai/provider] Missing GEMINI_API_KEY. Add it to .env.local and restart the dev server.",
    );
  }
  return key;
}

// Module-level singleton: re-initialising the SDK per call would
// reconnect every time and waste ~150ms of TLS handshake.
let _client: GoogleGenerativeAI | null = null;
function getClient(): GoogleGenerativeAI {
  if (!_client) _client = new GoogleGenerativeAI(resolveApiKey());
  return _client;
}

export const AI_CONFIG = {
  embedModel: process.env.GEMINI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
  /**
   * Default chat tier. "economy" (flash-lite) is the right default for
   * the demo — high RPM, low cost. Callers that need quality output
   * pass `tier: "quality"` via `chatComplete` options.
   */
  chatTier:
    (process.env.GEMINI_CHAT_TIER as ModelTier | undefined) ?? DEFAULT_CHAT_TIER,
  embeddingDim: EMBEDDING_DIM,
} as const;

// ---------- Types ----------

/** A single turn in a conversation. Role is "user" or "model". */
export type ChatRole = "user" | "model";

export interface ChatMessage {
  role: ChatRole;
  /** Plain text or an array of SDK `Part` objects (text, inline data, etc.). */
  parts: string | Part[];
}

export interface ChatOptions {
  /** System prompt prepended to the conversation. */
  systemInstruction?: string;
  /** Generation tuning: temperature 0-2, topK, topP, maxOutputTokens. */
  generationConfig?: Partial<GenerationConfig>;
  /** Tools available to the model (function calling). */
  tools?: GeminiTool[];
  /**
   * Force a specific model id (e.g. "gemini-3.5-flash"). Wins over `tier`.
   * Use this when a path has hard requirements on a model (e.g. the
   * cover letter agent needs the quality tier's larger context).
   */
  model?: string;
  /**
   * Model tier to use when `model` is not set. Quality = best model on
   * the account; economy = cheap/high-RPM model. Defaults to the value
   * in `AI_CONFIG.chatTier`.
   */
  tier?: ModelTier;
}

export interface EmbedOptions {
  /** Task hint sent to the embedding model. Improves retrieval quality. */
  taskType?: keyof typeof TaskType;
  title?: string;
  model?: string;
}

// ---------- Embeddings ----------

/**
 * Embed a single piece of text into a 3072-dim vector.
 * Returns a plain `number[]` so it can be stored directly in pgvector.
 */
export async function embedText(
  text: string,
  options: EmbedOptions = {},
): Promise<number[]> {
  if (!text || !text.trim()) {
    throw new Error("[ai/provider] embedText received empty input.");
  }
  const model = getClient().getGenerativeModel({
    model: options.model ?? AI_CONFIG.embedModel,
  });
  const result = await geminiBreaker().run(() =>
    withBackoff(
      () =>
        model.embedContent({
          content: { role: "user", parts: [{ text }] },
          ...(options.taskType ? { taskType: TaskType[options.taskType] } : {}),
          ...(options.title ? { title: options.title } : {}),
        }),
      { maxAttempts: 3, baseMs: 800, capMs: 8_000 },
    ),
  );
  const values = result.embedding?.values;
  if (!values || values.length !== EMBEDDING_DIM) {
    throw new Error(
      `[ai/provider] Embedding dim mismatch: expected ${EMBEDDING_DIM}, got ${values?.length ?? 0}. Check the model in AI_CONFIG.embedModel.`,
    );
  }
  return values;
}

/**
 * Embed many texts in one round trip. Used by the CV ingester to amortise
 * latency across chunks.
 */
export async function embedBatch(
  texts: string[],
  options: EmbedOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = getClient().getGenerativeModel({
    model: options.model ?? AI_CONFIG.embedModel,
  });
  const taskType = options.taskType ? TaskType[options.taskType] : undefined;
  const requests = texts.map((t, i) => {
    const req: {
      content: { role: "user"; parts: { text: string }[] };
      taskType?: typeof TaskType[keyof typeof TaskType];
      title?: string;
    } = {
      content: { role: "user", parts: [{ text: t }] },
    };
    if (taskType) req.taskType = taskType;
    req.title = options.title ?? `chunk-${i}`;
    return req;
  });
  const result = await geminiBreaker().run(() =>
    withBackoff(
      () => model.batchEmbedContents({ requests }),
      { maxAttempts: 3, baseMs: 800, capMs: 8_000 },
    ),
  );
  return result.embeddings.map((e, i) => {
    if (!e.values || e.values.length !== EMBEDDING_DIM) {
      throw new Error(
        `[ai/provider] Embedding dim mismatch in batch at index ${i}: expected ${EMBEDDING_DIM}, got ${e.values?.length ?? 0}.`,
      );
    }
    return e.values;
  });
}

// ---------- Chat (non-streaming) ----------

/**
 * Run a chat completion and return the model's final text response.
 * For streaming responses (used by /chat SSE), use `streamChat` instead.
 *
 * `messages` is converted to Gemini's `Content[]` shape: roles are
 * "user" / "model" and Gemini requires the first turn to be from "user".
 *
 * Model selection: explicit `options.model` wins, otherwise `options.tier`
 * is consulted, otherwise `AI_CONFIG.chatTier` is used. Each tier rotates
 * through 1-2 candidate models per minute so a burst of calls is spread.
 * On 429 / RESOURCE_EXHAUSTED we fall through to the next model in the
 * tier; the resilience layer's `withBackoff` handles same-model retries.
 */
export async function chatComplete(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  if (messages.length === 0) {
    throw new Error("[ai/provider] chatComplete received an empty message list.");
  }
  const tier = options.tier ?? AI_CONFIG.chatTier;
  const initial = options.model
    ? {
        model: options.model,
        maxOutputTokens: options.generationConfig?.maxOutputTokens ?? 1024,
      }
    : pickModel(tier);

  return runWithModelFallback(messages, options, initial, tier);
}

async function runWithModelFallback(
  messages: ChatMessage[],
  options: ChatOptions,
  initial: { model: string; maxOutputTokens: number },
  tier: ModelTier,
): Promise<string> {
  const tried = new Set<string>();
  let current = initial;

  while (true) {
    tried.add(current.model);
    try {
      return await runSingleChat(messages, options, current);
    } catch (err) {
      // Only fall back to a different model on rate-limit / quota errors.
      // Non-rate-limit errors (schema parse, bad prompt, etc.) should
      // surface immediately so we don't paper over real bugs.
      if (!isRateLimitError(err)) throw err;

      const fallback = nextModel(tier, current.model);
      if (!fallback || tried.has(fallback.model)) {
        // No more models in the tier to try, or we've already tried
        // the fallback. Surface the original error.
        throw err;
      }
      console.warn(
        `[ai/provider] model ${current.model} rate-limited, falling back to ${fallback.model}`,
      );
      current = fallback;
    }
  }
}

async function runSingleChat(
  messages: ChatMessage[],
  options: ChatOptions,
  pick: { model: string; maxOutputTokens: number },
): Promise<string> {
  const model = getClient().getGenerativeModel({
    model: pick.model,
    systemInstruction: options.systemInstruction,
    generationConfig: options.generationConfig,
    tools: options.tools,
  });

  const { history, lastParts } = splitHistory(messages);
  const chat = model.startChat({ history });
  const result = await geminiBreaker().run(() =>
    withBackoff(() => chat.sendMessage(lastParts), {
      maxAttempts: 3,
      baseMs: 800,
      capMs: 8_000,
    }),
  );

  // Guard against a silently-truncated response (finishReason=MAX_TOKENS or
  // empty text). RetryableError is rate-limit retry; for content truncation
  // we surface a clear message so the route can fall back.
  const text = result.response.text();
  if (!text) {
    throw new RetryableError(
      "[ai/provider] chatComplete returned empty text (likely MAX_TOKENS). " +
        "Caller should retry with a larger maxOutputTokens or a shorter prompt.",
      { status: 504 },
    );
  }
  return text;
}

// ---------- Chat (streaming) ----------

/**
 * Stream a chat completion. Yields raw text chunks as they arrive so the
 * caller can flush them straight to the SSE response.
 *
 * The Gemini SDK returns an async iterable of `EnhancedGenerateContentResponse`
 * whose `.text()` is incrementally populated; we extract each delta.
 */
export async function* streamChat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<string, void, undefined> {
  if (messages.length === 0) {
    throw new Error("[ai/provider] streamChat received an empty message list.");
  }
  const tier = options.tier ?? AI_CONFIG.chatTier;
  const pick = options.model
    ? { model: options.model, maxOutputTokens: 1024 }
    : pickModel(tier);
  const model = getClient().getGenerativeModel({
    model: pick.model,
    systemInstruction: options.systemInstruction,
    generationConfig: options.generationConfig,
    tools: options.tools,
  });

  const { history, lastParts } = splitHistory(messages);
  const chat = model.startChat({ history });
  const stream = await chat.sendMessageStream(lastParts);
  for await (const chunk of stream.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}

// ---------- Internal helpers ----------

/**
 * Gemini's startChat({history, ...}) pattern requires the *last* message to be
 * sent via sendMessage, not included in the history. We split the last "user"
 * turn off the end of the conversation and convert role names to the
 * "user" / "model" vocabulary Gemini uses internally.
 */
function splitHistory(messages: ChatMessage[]): {
  history: Content[];
  lastUserMessage: ChatMessage;
  lastParts: Part[];
} {
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  if (!last || last.role !== "user") {
    throw new Error(
      `[ai/provider] Last message must be from "user"; got "${last?.role ?? "undefined"}". Add a final user turn before calling chat.`,
    );
  }
  const history: Content[] = messages.slice(0, lastIdx).map((m) => ({
    role: m.role,
    parts: Array.isArray(m.parts) ? m.parts : [{ text: m.parts }],
  }));
  const lastParts: Part[] = Array.isArray(last.parts) ? last.parts : [{ text: last.parts }];
  return { history, lastUserMessage: last, lastParts };
}
