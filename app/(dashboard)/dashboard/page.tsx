import { TrendingUp, BookmarkCheck, Flame } from "lucide-react";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { computeStreak } from "@/lib/productivity/streak";
import type { WeeklyStats } from "@/lib/productivity/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const userId = await requireUserId();

  // Weekly aggregates from the SQL view (may be empty for new users).
  const { data: statsRow } = await supabaseAdmin
    .from("v_weekly_stats")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle<WeeklyStats>();

  // Bookmark count and per-card fit_score rows. The Hunter agent writes
  // fit_score (0..100) into hunter_saved whenever a card is saved, and
  // GET /api/hunt/save?recompute=1 refreshes it when the CV is updated.
  // We read both in a single round-trip so the dashboard can show an
  // honest average across whatever the user has bookmarked.
  const { count: savedCount, data: savedRows } = await supabaseAdmin
    .from("hunter_saved")
    .select("fit_score", { count: "exact" })
    .eq("user_id", userId);

  const streak = await computeStreak(userId);
  const appsSent = statsRow?.apps_sent ?? 0;
  const todosDone = statsRow?.todos_done ?? 0;
  const interviewCount = await countInterviews(userId);

  // Real avg fit across the cards that have a score on file. Newer cards
  // written before the schema migration may have fit_score = null, those
  // are skipped so a single legacy row cannot drag the average to 0.
  const scoredRows = (savedRows ?? []).filter(
    (r: { fit_score: number | null }) => typeof r.fit_score === "number",
  );
  const avgFit = scoredRows.length
    ? Math.round(
        scoredRows.reduce(
          (acc: number, r: { fit_score: number | null }) =>
            acc + (r.fit_score as number),
          0,
        ) / scoredRows.length,
      )
    : null;
  return (
    <div className="container-wide space-y-8 py-10 md:py-14">
      <header>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Your job search, on autopilot.
        </h1>
        <p className="mt-1 text-sm text-secondary-500">
          Real-time view of applications and pipeline momentum.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Applications"
          value={String(appsSent)}
          delta={`${interviewCount} interviews`}
          icon={TrendingUp}
        />
        <StatCard
          label="Saved jobs"
          value={String(savedCount ?? 0)}
          delta={
            avgFit === null
              ? "bookmark a role in Job Hunter to see its fit score"
              : `avg fit ${avgFit}% across ${scoredRows.length} card${
                  scoredRows.length === 1 ? "" : "s"
                }`
          }
          icon={BookmarkCheck}
        />
        <StatCard
          label="Streak"
          value={`${streak.days}d`}
          delta={
            streak.lastActiveDate
              ? `last active ${streak.lastActiveDate}`
              : "complete a todo to begin"
          }
          icon={Flame}
        />
      </section>

      <section className="rounded-2xl border border-secondary-100 bg-white p-6 shadow-card">
        <h2 className="font-heading text-lg font-semibold">This week</h2>
        <p className="mt-1 text-sm text-secondary-500">
          {todosDone} to-do{todosDone === 1 ? "" : "s"} completed · {appsSent}{" "}
          application move{appsSent === 1 ? "" : "s"} on the tracker.
        </p>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  delta,
  icon: Icon,
}: {
  label: string;
  value: string;
  delta: string;
  icon: typeof TrendingUp;
}) {
  return (
    <article className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-secondary-400">
          {label}
        </p>
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary-50 text-primary">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="font-heading mt-3 text-3xl font-extrabold tracking-tight">
        {value}
      </p>
      <p className="mt-1 text-xs text-secondary-500">{delta}</p>
    </article>
  );
}

async function countInterviews(userId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("applications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "interviewing");
  return count ?? 0;
}
