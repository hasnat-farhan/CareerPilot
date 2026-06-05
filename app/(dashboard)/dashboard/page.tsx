import { TrendingUp, FileText, Target, CheckCircle2 } from "lucide-react";

const stats = [
  { label: "Applications", value: "24", delta: "+6 this week", icon: TrendingUp },
  { label: "CV match rate", value: "78%", delta: "+3% vs last week", icon: FileText },
  { label: "Active goals", value: "5", delta: "2 due this week", icon: Target },
  { label: "Interviews", value: "4", delta: "+2 this week", icon: CheckCircle2 },
];

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Your job search, on autopilot.
        </h1>
        <p className="mt-1 text-sm text-muted">
          Real-time view of applications, skills, and roadmap progress.
        </p>
      </div>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(({ label, value, delta, icon: Icon }) => (
          <article
            key={label}
            className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card"
          >
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
            <p className="mt-1 text-xs text-muted">{delta}</p>
          </article>
        ))}
      </section>

      <section className="rounded-2xl border border-secondary-100 bg-white p-6 shadow-card">
        <h2 className="font-heading text-lg font-semibold">Next actions</h2>
        <p className="mt-1 text-sm text-muted">
          Hook up Supabase to populate this with your real data.
        </p>
      </section>
    </div>
  );
}
