// CareerPilot — LLM resilience layer.
//
// Two small, dependency-free utilities for guarding any structured-LLM call
// against transient rate-limit (HTTP 429) and quota-exhausted (RESOURCE_EXHAUSTED)
// failures from upstream providers (Gemini / OpenAI / Anthropic).
//
//   1. withBackoff(fn)  — exponential backoff with full jitter, max 3 attempts.
//                         Catches RetryableError and retries; passes other errors
//                         through immediately so we don't paper over real bugs.
//
//   2. CircuitBreaker   — per-provider in-memory state. After 3 consecutive
//                         rate-limit failures within 60s, the circuit opens for
//                         30s and short-circuits to the fallback provider. This
//                         is what prevents the "pound the quota" failure mode.
//
// Both are intentionally pure-Node, no Redis, no external state — they protect
// a single server process. For multi-instance deployments swap the Map
// for a Redis-backed implementation, but for a single Vercel serverless
// instance or a dev server, in-memory is sufficient and predictable.
//
// Usage (in hunter.ts):
//
//   const breaker = new CircuitBreaker("gemini", { threshold: 3, cooldownMs: 30_000 });
//   const result = await breaker.run(
//     () => withBackoff(() => gemini.generateContent(...), { maxAttempts: 3 })
//   );
//
// The route layer is responsible for switching to a cached/partial result
// when the breaker is OPEN or all retries are exhausted.

export class RetryableError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, opts?: { status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = "RetryableError";
    this.status = opts?.status;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

/**
 * True when an error from an LLM provider is a transient rate-limit / quota
 * failure that a backoff loop should attempt again. We match the standard
 * Google/OpenAI/Anthropic status codes and the error codes surfaced in their
 * SDKs (RESOURCE_EXHAUSTED, rate_limit_exceeded, 429).
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  // Our own wrapped errors
  if (err instanceof RetryableError) return true;
  // Raw shapes from each SDK
  const anyErr = err as { status?: number; code?: number | string; statusCode?: number; message?: string };
  if (anyErr.status === 429 || anyErr.code === 429 || anyErr.statusCode === 429) return true;
  if (anyErr.code === 8 || anyErr.code === "RESOURCE_EXHAUSTED") return true; // Google SDK
  const msg = (anyErr.message ?? "").toLowerCase();
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("resource_exhausted") || msg.includes("quota exceeded")) {
    return true;
  }
  return false;
}

export type BackoffOpts = {
  maxAttempts?: number;   // total attempts including the first (default 3)
  baseMs?: number;        // first backoff window (default 500ms)
  capMs?: number;         // ceiling for any single backoff (default 8000ms)
};

/**
 * Exponential backoff with full jitter. Returns the first successful value
 * or throws the last error (wrapped in RetryableError when it was a rate-limit
 * error, so the caller / circuit breaker can recognise it).
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOpts = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseMs = opts.baseMs ?? 500;
  const capMs = opts.capMs ?? 8_000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err)) {
        // Non-retryable — surface immediately so we don't mask real bugs.
        throw err;
      }
      if (attempt === maxAttempts) break;

      // Full-jitter exponential: random in [0, min(cap, base * 2^(attempt-1))]
      const window = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const sleepMs = Math.floor(Math.random() * window);
      console.warn(
        `[backoff] attempt ${attempt}/${maxAttempts} hit rate limit, retrying in ${sleepMs}ms`,
      );
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  // All attempts exhausted by rate-limit errors. Wrap so the breaker can see it.
  const e = lastErr as { status?: number; message?: string };
  throw new RetryableError(
    `Rate-limited after ${maxAttempts} attempts: ${e?.message ?? "unknown"}`,
    { status: e?.status ?? 429 },
  );
}

// ---------- Circuit breaker ----------

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type CircuitOpts = {
  threshold?: number;     // consecutive failures to trip (default 3)
  cooldownMs?: number;    // how long to stay OPEN before half-open (default 30_000)
  windowMs?: number;      // rolling window for the failure counter (default 60_000)
};

type Entry = {
  state: CircuitState;
  consecutiveFailures: number;
  firstFailureAt: number; // when the current streak started
  openedAt: number;       // when we last entered OPEN
};

const REGISTRY = new Map<string, Entry>();

/**
 * Per-provider circuit breaker. In-memory, one entry per provider name.
 *
 *   CLOSED     → calls pass through; failures increment a counter.
 *   OPEN       → calls short-circuit to a "circuit open" error.
 *   HALF_OPEN  → one trial call is allowed; success closes the circuit,
 *                 failure re-opens it for another cooldown.
 */
export class CircuitBreaker {
  private readonly name: string;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly windowMs: number;

  constructor(name: string, opts: CircuitOpts = {}) {
    this.name = name;
    this.threshold = opts.threshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.windowMs = opts.windowMs ?? 60_000;
  }

  private getEntry(): Entry {
    const now = Date.now();
    let e = REGISTRY.get(this.name);
    if (!e) {
      e = { state: "CLOSED", consecutiveFailures: 0, firstFailureAt: 0, openedAt: 0 };
      REGISTRY.set(this.name, e);
      return e;
    }
    // Reset the rolling window if it expired
    if (e.consecutiveFailures > 0 && now - e.firstFailureAt > this.windowMs) {
      e.consecutiveFailures = 0;
      e.firstFailureAt = 0;
      e.state = "CLOSED";
    }
    // Promote OPEN → HALF_OPEN once cooldown elapsed
    if (e.state === "OPEN" && now - e.openedAt >= this.cooldownMs) {
      e.state = "HALF_OPEN";
      console.warn(`[circuit:${this.name}] OPEN → HALF_OPEN (probing)`);
    }
    return e;
  }

  /** Returns true if the circuit is closed (or half-open, allowing a trial). */
  get isCallAllowed(): boolean {
    return this.getEntry().state !== "OPEN";
  }

  /** Execute fn under the breaker. Throws RetryableError when OPEN. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const e = this.getEntry();
    if (e.state === "OPEN") {
      throw new RetryableError(
        `Circuit '${this.name}' is OPEN; skipping call (cooldown ${this.cooldownMs}ms)`,
        { status: 503 },
      );
    }
    try {
      const out = await fn();
      this.onSuccess();
      return out;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    const e = this.getEntry();
    if (e.state === "HALF_OPEN") {
      console.warn(`[circuit:${this.name}] HALF_OPEN → CLOSED (probe succeeded)`);
    }
    e.state = "CLOSED";
    e.consecutiveFailures = 0;
    e.firstFailureAt = 0;
  }

  private onFailure(): void {
    const e = this.getEntry();
    const now = Date.now();
    if (e.consecutiveFailures === 0) e.firstFailureAt = now;
    e.consecutiveFailures += 1;
    if (e.consecutiveFailures >= this.threshold && e.state !== "OPEN") {
      e.state = "OPEN";
      e.openedAt = now;
      console.warn(
        `[circuit:${this.name}] → OPEN after ${e.consecutiveFailures} consecutive failures ` +
          `(cooldown ${this.cooldownMs}ms)`,
      );
    }
  }
}

// Process-wide singleton for the Gemini provider — shared across requests
// in the same Node process. Import this from anywhere; the constructor is
// idempotent per name.
let _geminiBreaker: CircuitBreaker | null = null;
export function geminiBreaker(): CircuitBreaker {
  if (!_geminiBreaker) _geminiBreaker = new CircuitBreaker("gemini");
  return _geminiBreaker;
}
