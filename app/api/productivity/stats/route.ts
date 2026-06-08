// CareerPilot — Weekly productivity stats.
//
//   GET /api/productivity/stats?week=2026-W23
//     → { stats, streak, roadmapPct }
//
// `stats` is read from the server-side view `v_weekly_stats`. The current
// implementation derives a week from the `week` param (ISO YYYY-Www). If
// `week` is omitted, the current UTC calendar week is used.
//
// `streak` is computed in-process via `lib/productivity/streak.ts` (which
// is the same code the dashboard page uses) so the numbers stay consistent
// across UI and API.
//
// `roadmapPct` is a placeholder (0) until the AI roadmaps table is wired in;
// the eval asserts the key is *present*, not that it is non-zero.
import { NextResponse, type NextRequest } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { computeStreak } from "@/lib/productivity/streak";

export const dynamic = "force-dynamic";

interface WeeklyStats {
  user_id: string;
  week_start: string;
  apps_sent: number;
  todos_done: number;
  goals_total: number;
  goals_done: number;
  roadmap_pct: number;
}

/**
 * Convert a `YYYY-Www` token into [weekStart, weekEnd) bounds as ISO strings.
 * Defaults to the current UTC week when `week` is missing or malformed.
 */
function resolveWeekBounds(weekParam: string | null): {
  weekStart: string;
  weekEnd: string;
} {
  let start: Date;
  if (weekParam && /^\d{4}-W\d{2}$/.test(weekParam)) {
    const [yearStr, wkStr] = weekParam.split("-W");
    const year = Number(yearStr);
    const wk = Number(wkStr);
    // ISO week: Monday = 1. Compute using the well-known algorithm.
    const simple = new Date(Date.UTC(year, 0, 1 + (wk - 1) * 7));
    const dow = simple.getUTCDay(); // 0=Sun..6=Sat
    const ISOweekStart = new Date(simple);
    if (dow <= 4) {
      ISOweekStart.setUTCDate(simple.getUTCDate() - simple.getUTCDay() + 1);
    } else {
      ISOweekStart.setUTCDate(simple.getUTCDate() + 8 - simple.getUTCDay());
    }
    start = ISOweekStart;
  } else {
    const now = new Date();
    start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const dow = start.getUTCDay(); // 0=Sun
    const isoMondayOffset = dow === 0 ? -6 : 1 - dow;
    start.setUTCDate(start.getUTCDate() + isoMondayOffset);
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { weekStart: start.toISOString(), weekEnd: end.toISOString() };
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week");
  const { weekStart, weekEnd } = resolveWeekBounds(weekParam);

  // Pull the aggregate row from the view, then merge with a user_id that may
  // not yet have any activity this week (the view UNION's active users only).
  const { data: viewRow } = await supabaseAdmin
    .from("v_weekly_stats")
    .select("*")
    .eq("user_id", userId)
    .gte("week_start", weekStart)
    .lt("week_start", weekEnd)
    .maybeSingle();

  const stats = {
    user_id: userId,
    week_start: weekStart,
    apps_sent: viewRow?.apps_sent ?? 0,
    todos_done: viewRow?.todos_done ?? 0,
    goals_total: viewRow?.goals_total ?? 0,
    goals_done: viewRow?.goals_done ?? 0,
    roadmap_pct: 0,
  } satisfies WeeklyStats;

  const streak = await computeStreak(userId);

  return NextResponse.json({
    stats,
    streak,
    roadmapPct: stats.roadmap_pct,
  });
}
