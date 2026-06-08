"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Client-side warmup status provider.
 *
 * Wraps the dashboard group layout. Polls `GET /api/cv/list?warmup=1`
 * to detect the presence of any `__warmup__` placeholder row, which
 * the `_warmup` route creates for the first ~6–22s of the user's
 * first session and then deletes. While that row is in flight, the
 * CV management page disables its upload button via this context.
 *
 * Why a client polling loop?
 *   The warmup is kicked off via `next/server`'s `after()` from a
 *   server component. Server components can't push status to the
 *   client, so we ask politely. The poll interval is 1s — the
 *   warmup is short and the request is cheap (one indexed query
 *   against `cvs.user_id`).
 *
 * The hook returns `{ isWarming }`. `isWarming` flips to `false`
 * as soon as the warmup row is gone OR after `WARMUP_TIMEOUT_MS`
 * (whichever comes first), so a stuck warmup can't lock the UI
 * forever.
 */

const POLL_INTERVAL_MS = 1000;
const WARMUP_TIMEOUT_MS = 60_000; // 60s — Vercel Pro's maxDuration. A warmup that runs longer is a bug, not a user-facing constraint.

type WarmupContextValue = {
  /** True while the warmup row is in flight (or until the timeout). */
  isWarming: boolean;
};

const WarmupContext = createContext<WarmupContextValue>({ isWarming: false });

export function useWarmupStatus(): WarmupContextValue {
  return useContext(WarmupContext);
}

export function WarmupProvider({ children }: { children: ReactNode }) {
  // Default to `true` so the very first render of the CV page
  // shows the disabled state. The first poll will correct us
  // within a second if the user has already warmed up.
  const [isWarming, setIsWarming] = useState(true);
  const startedAt = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled) return;

      // Hard timeout: don't poll forever. The user shouldn't be
      // blocked indefinitely if the warmup got stuck.
      if (Date.now() - startedAt.current > WARMUP_TIMEOUT_MS) {
        setIsWarming(false);
        return;
      }

      try {
        const res = await fetch("/api/cv/list?warmup=1", {
          cache: "no-store",
        });
        if (!res.ok) {
          // Auth errors, network blips, etc. — keep waiting; the
          // timeout is the only thing that flips us out of warming.
          scheduleNext();
          return;
        }
        const body = (await res.json()) as { cvs?: Array<{ id: string }> };
        const warmupRows = body.cvs ?? [];

        if (warmupRows.length === 0) {
          // Warmup row is gone — either the _warmup route cleaned
          // it up, or it never existed (e.g. the dashboard
          // decided not to fire one because the cookie was set).
          setIsWarming(false);
          return;
        }

        // Still in flight. Keep polling.
        scheduleNext();
      } catch {
        scheduleNext();
      }
    };

    const scheduleNext = (): void => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <WarmupContext.Provider value={{ isWarming }}>
      {children}
    </WarmupContext.Provider>
  );
}
