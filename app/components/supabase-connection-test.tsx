"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Status =
  | { kind: "loading" }
  | { kind: "ok"; hasSession: boolean; url: string }
  | { kind: "error"; message: string };

/**
 * Drop-in smoke test for the Supabase browser client. Renders a small
 * status pill in the bottom-right of the page AND logs the outcome to
 * the browser console. Safe to leave mounted in development.
 *
 * Intended for use while the database is empty: this verifies that the
 * publishable key + URL reach Supabase and that the auth endpoint
 * responds, without needing any tables to exist.
 */
export function SupabaseConnectionTest() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(missing)";
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "(missing)";

    // eslint-disable-next-line no-console
    console.log("[SUPABASE_TEST] Booting — env check:", {
      url,
      keyPrefix: key === "(missing)" ? "(missing)" : `${key.slice(0, 12)}…`,
    });

    if (!url || url === "(missing)" || !key || key === "(missing)") {
      const msg =
        "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in env";
      // eslint-disable-next-line no-console
      console.error("[SUPABASE_TEST] ❌", msg);
      setStatus({ kind: "error", message: msg });
      return;
    }

    let cancelled = false;
    const supabase = createClient();

    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // eslint-disable-next-line no-console
          console.error("[SUPABASE_TEST] ❌ getSession error:", error);
          setStatus({ kind: "error", message: error.message });
          return;
        }
        const hasSession = Boolean(data.session);
        // eslint-disable-next-line no-console
        console.log(
          "[SUPABASE_TEST] ✅ Connection OK — auth.getSession() resolved.",
          { hasSession },
        );
        setStatus({ kind: "ok", hasSession, url });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error("[SUPABASE_TEST] ❌ Unexpected error:", err);
        setStatus({ kind: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 max-w-xs rounded-lg border bg-white px-3 py-2 text-xs font-mono shadow-card"
    >
      <div className="font-bold text-secondary-700">Supabase</div>
      {status.kind === "loading" && (
        <div className="mt-1 text-secondary-500">testing connection…</div>
      )}
      {status.kind === "ok" && (
        <div className="mt-1 text-primary-600">
          ✅ connected
          <div className="font-normal text-secondary-500">
            session: {status.hasSession ? "yes" : "no"}
          </div>
        </div>
      )}
      {status.kind === "error" && (
        <div className="mt-1 text-red-600">
          ❌ {status.message}
        </div>
      )}
    </div>
  );
}
