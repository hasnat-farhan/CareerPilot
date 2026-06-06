// Streak counter for the Dashboard.
//
// Counts consecutive calendar days (UTC, midnight to midnight) on which
// the user EITHER completed a todo OR moved an application to a new
// status. A break in activity resets the streak to 0.

import { supabaseAdmin } from "@/lib/supabase/admin";

export interface StreakInfo {
  days: number;
  lastActiveDate: string | null; // YYYY-MM-DD
}

export async function computeStreak(userId: string): Promise<StreakInfo> {
  // Pull the most recent 60 days of activity from both tables.
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const [todosRes, appsRes] = await Promise.all([
    supabaseAdmin
      .from("todos")
      .select("done_at")
      .eq("user_id", userId)
      .eq("done", true)
      .gte("done_at", since)
      .not("done_at", "is", null),
    supabaseAdmin
      .from("applications")
      .select("status_updated_at")
      .eq("user_id", userId)
      .gte("status_updated_at", since),
  ]);

  const days = new Set<string>();
  for (const t of todosRes.data ?? []) {
    if (t.done_at) days.add(t.done_at.slice(0, 10));
  }
  for (const a of appsRes.data ?? []) {
    if (a.status_updated_at) days.add(a.status_updated_at.slice(0, 10));
  }

  // Walk back from today (UTC). Each consecutive day bumps the streak.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let cursor = today;
  let count = 0;
  // If today has no activity, the streak is "still alive from yesterday" —
  // walk from today first; if today is missing, the streak may have
  // ended yesterday. We treat a missing-today as 0 for v1 (clearer UX).
  for (let i = 0; i < 60; i++) {
    const key = cursor.toISOString().slice(0, 10);
    if (days.has(key)) {
      count += 1;
      cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    } else {
      break;
    }
  }

  // Last active date = the most recent date in the set, if any.
  const lastActive = [...days].sort().pop() ?? null;

  return { days: count, lastActiveDate: lastActive };
}
