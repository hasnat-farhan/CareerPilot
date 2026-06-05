// CareerPilot — rate limiter removed for demo tier.
//
// The free Gemini tier used during the demo has 15 RPM on flash-lite and
// 500 RPD, so a per-process token bucket was throttling legitimate clicks
// (especially when a user fires all four chips in a row). We now rely on
// the circuit breaker + exponential backoff in `lib/ai/resilience.ts` as
// a transient-error safety net, and on the 2-tier model picker in
// `lib/ai/models.ts` to spread burst load across multiple models.
//
// The named exports below are kept as no-op shims so that any stray import
// (`import { chatGate } from "@/lib/ai/rate-limit"`) still resolves and
// the app boots. New code should not use them.
//
// If you ever need a real rate limit (e.g. for a paid production deploy
// with hard per-minute quotas), replace this file with a Redis-backed
// token bucket or a leaky bucket library and re-wire `provider.ts`.

export const chatGate = () => async () => undefined;
export const embedGate = () => async () => undefined;
export const rateLimit = {
  /** @deprecated kept for back-compat; no-op. */
  acquire: async () => undefined,
} as const;
