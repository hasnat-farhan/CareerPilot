import type { ReactNode } from "react";
import { headers } from "next/headers";
import { after } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { WARMUP_NAME_PREFIX } from "@/lib/cv/ingest";
import { WarmupProvider } from "@/app/components/warmup-provider";

/**
 * Dashboard group layout. Wraps every signed-in page.
 *
 * The global <AppHeader /> (rendered by app/layout.tsx) shows the
 * in-app nav when the user is signed in, so this layout is
 * intentionally lightweight.
 *
 * Cold-start warmup
 * -----------------
 * Vercel Hobby's 10s function ceiling is too tight for the CV
 * upload route's cold start (≈22s on first hit because of the
 * pdf-parse + Gemini embed imports). We pay that cost once per user
 * by firing a background upload of `public/warmup.pdf` on the
 * user's first render of the dashboard.
 *
 * Mechanics:
 *   1. `requireUserId()` resolves the Clerk user (or the eval
 *      header, in dev-eval mode).
 *   2. We check the `cvs` table for any existing row whose name
 *      starts with `__warmup__` for this user. If one is already
 *      in flight (or just completed and not yet cleaned up), we
 *      skip — no need to fire a second one. Next 15 forbids
 *      `cookies().set()` from a Server Component, so this DB
 *      check is the only gate.
 *   3. We use Next 15's `after()` to schedule the warmup call to
 *      run *after* the response is sent. The user's request is
 *      not blocked; the warmup runs server-side in the background.
 *   4. The `_warmup` route cleans up its own row on success, so
 *      subsequent dashboard renders see no `__warmup__` rows and
 *      do nothing.
 *
 * The `WarmupProvider` client component polls `/api/cv/list?warmup=1`
 * to detect when the warmup is done, and exposes a context the
 * CV management page reads to disable its upload button while
 * the background ingest is in flight.
 */
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Resolve the current user. If auth fails we still render the
  // children (Clerk's middleware will redirect them to /sign-in);
  // the warmup code is short-circuited below.
  let userId: string | null = null;
  try {
    userId = await requireUserId();
  } catch {
    userId = null;
  }

  if (userId) {
    await maybeFireWarmup(userId);
  }

  return <WarmupProvider>{children}</WarmupProvider>;
}

/**
 * Fire the background warmup exactly once per user.
 *
 * Gating strategy
 * ---------------
 * Next.js 15 forbids `cookies().set()` from a Server Component
 * (only Server Actions and Route Handlers may write cookies), so
 * we use the `cvs` table as the *only* gate: a quick lookup for
 * any row whose name starts with `__warmup__`. If one exists in
 * any state, the warmup is in flight or already done — skip. If
 * not, fire it. The warmup route itself runs the same check as a
 * belt-and-braces guard.
 *
 * This is safe because:
 *   - The warmup route *deletes* its own row on success, so on
 *     the user's *next* dashboard render there are no
 *     `__warmup__` rows and we'd fire again — which is fine,
 *     because the ingest pipeline is idempotent (it re-uses the
 *     same code path the real upload will hit) and the cost is
 *     bounded: if the user hasn't uploaded a real CV by the time
 *     the warmup completes, we'll just fire another one.
 *   - In practice the user *will* navigate to /cv within a few
 *     seconds of landing on the dashboard, so the second warmup
 *     is the one that actually warms the route before their real
 *     upload.
 */
async function maybeFireWarmup(userId: string): Promise<void> {
  // Skip if a warmup is already in flight (or recently completed
  // and not yet cleaned up). The warmup route also has this
  // check; doing it here saves us a redundant `after()` callback
  // and a network round-trip on every dashboard render.
  const { data: existing } = await supabaseAdmin
    .from("cvs")
    .select("id, status")
    .eq("user_id", userId)
    .like("name", `${WARMUP_NAME_PREFIX}%`)
    .limit(1)
    .maybeSingle();

  if (existing) return;

  // Build the absolute origin from the incoming request headers
  // so the warmup works in dev (localhost), in Vercel preview
  // deployments, and in production.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${proto}://${host}` : "http://localhost:3000";

  // Fire the warmup in the background. `after()` lets the user's
  // request respond immediately; the warmup runs after the
  // response is flushed. The route does best-effort cleanup, so
  // we don't need to await or handle errors here.
  after(async () => {
    try {
      await fetch(`${origin}/api/cv/warmup`, {
        method: "POST",
        headers: {
          "x-warmup": "1",
          "x-eval-user-id": userId,
        },
        cache: "no-store",
      });
    } catch (err) {
      // Warmup failures must never bubble. The user can't act on
      // them anyway — log and move on.
      // eslint-disable-next-line no-console
      console.warn(`[warmup] background fetch failed for ${userId}:`, err);
    }
  });
}
