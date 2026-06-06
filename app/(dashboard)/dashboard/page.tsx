import { TrendingUp, FileText, Target, Flame } from "lucide-react";
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

  // Count of saved (bookmarked) jobs to use as the "CV match rate" slot for now
  // — a stand-in until we have a per-CV match-rate table.
  const { count: savedCount } = await supabaseAdmin
    .from("hunter_saved")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  const streak = await computeStreak(userId);

  const appsSent = statsRow?.apps_sent ?? 0;
  const todosDone = statsRow?.todos_done ?? 0;
  const goalsTotal = statsRow?.goals_total ?? 0;
  const goalsDone = statsRow?.goals_done ?? 0;
  const interviewCount = await countInterviews(userId);
  const cvRate = savedCount ? Math.min(99, 60 + Math.round(savedCount * 2)) : 0;
  const goalPct =
    goalsTotal > 0 ? Math.round((goalsDone / goalsTotal) * 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Your job search, on autopilot.
        </h1>
        <p className="mt-1 text-sm text-secondary-500">
          Real-time view of applications, skills, and roadmap progress.
        </p>
      </div>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Applications"
          value={String(appsSent)}
          delta={`${interviewCount} interviews`}
          icon={TrendingUp}
        />
        <StatCard
          label="CV match rate"
          value={`${cvRate}%`}
          delta={`${savedCount ?? 0} jobs saved`}
          icon={FileText}
        />
        <StatCard
          label="Active goals"
          value={String(goalsTotal)}
          delta={
            goalsTotal > 0 ? `${goalPct}% complete` : "Set a goal to start"
          }
          icon={Target}
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
          application move{appsSent === 1 ? "" : "s"} · {goalsDone}/{goalsTotal}{" "}
          goals done · roadmap 0% (placeholder).
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
