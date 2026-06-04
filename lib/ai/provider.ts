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
 *   - Chat (sync):  gemini-3.5-flash
 *   - Chat (stream): gemini-3.5-flash (server-streaming via generateContentStream)
 *
 * Auth:
 *   The SDK constructor accepts a raw string API key. The actual value can be
 *   set under either the canonical name (GEMINI_API_KEY) or the legacy
 *   misspelled name (Gemini_API_Key) that ships in some local .env files.
 *   We standardise on the canonical name in code, but tolerate the legacy
 *   one so a freshly-cloned repo with a stale .env.local still boots.
 */

import {
  GoogleGenerativeAI,
  TaskType,
  type Content,
  type GenerationConfig,
  type Part,
  type Tool as GeminiTool,
} from "@google/generative-ai";

// ---------- Configuration ----------

const DEFAULT_EMBED_MODEL = "gemini-embedding-2";
const DEFAULT_CHAT_MODEL = "gemini-3.5-flash";

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
  chatModel: process.env.GEMINI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL,
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
  /** Force a specific model instead of the default. */
  model?: string;
}

export interface EmbedOptions {
  /** Task hint sent to the embedding model. Improves retrieval quality. */
  taskType?: keyof typeof TaskType;
  title?: string;
  model?: string;
}

// ---------- Embeddings ----------

/**
 * Embed a single piece of text into a 768-dim vector.
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
  const result = await model.embedContent({
    content: { role: "user", parts: [{ text }] },
    ...(options.taskType ? { taskType: TaskType[options.taskType] } : {}),
    ...(options.title ? { title: options.title } : {}),
  });
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
  const result = await model.batchEmbedContents({ requests });
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
 */
export async function chatComplete(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  if (messages.length === 0) {
    throw new Error("[ai/provider] chatComplete received an empty message list.");
  }
  const model = getClient().getGenerativeModel({
    model: options.model ?? AI_CONFIG.chatModel,
    systemInstruction: options.systemInstruction,
    generationConfig: options.generationConfig,
    tools: options.tools,
  });

  const { history, lastUserMessage, lastParts } = splitHistory(messages);
  const chat = model.startChat({ history });
  const result = await chat.sendMessage(lastParts);
  return result.response.text();
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
  const model = getClient().getGenerativeModel({
    model: options.model ?? AI_CONFIG.chatModel,
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
