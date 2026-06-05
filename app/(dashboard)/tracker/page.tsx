import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

const columns = [
  { id: "applied", title: "Applied", accent: "bg-secondary-100" },
  { id: "interviewing", title: "Interviewing", accent: "bg-primary-100" },
  { id: "offer", title: "Offer", accent: "bg-emerald-100" },
  { id: "rejected", title: "Rejected", accent: "bg-rose-100" },
] as const;

const sample = {
  applied: [
    { company: "Pathao", role: "Senior Full-Stack Engineer" },
    { company: "bKash", role: "Product Engineer, Fintech" },
  ],
  interviewing: [
    { company: "Sheba.xyz", role: "Engineering Manager" },
  ],
  offer: [
    { company: "CareerPilot Labs", role: "Founding Engineer" },
  ],
  rejected: [],
} as const;

export default function TrackerPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Your pipeline, at a glance.
        </h1>
        <p className="mt-1 text-sm text-muted">
          Drag cards across columns to update their status.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {columns.map((col) => (
          <section
            key={col.id}
            className="rounded-2xl border border-secondary-100 bg-white p-4 shadow-card"
          >
            <header className="mb-3 flex items-center justify-between">
              <h2 className="font-heading text-sm font-semibold">{col.title}</h2>
              <span
                className={cn(
                  "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold",
                  col.accent,
                )}
              >
                {sample[col.id].length}
              </span>
            </header>
            <div className="space-y-2">
              {sample[col.id].length === 0 ? (
                <p className="rounded-lg border border-dashed border-secondary-200 p-4 text-center text-xs text-muted">
                  No applications yet.
                </p>
              ) : (
                sample[col.id].map((app) => (
                  <article
                    key={app.company}
                    className="rounded-lg border border-secondary-100 bg-surface/40 p-3 transition hover:border-primary hover:bg-white"
                  >
                    <div className="flex items-center gap-2">
                      <span className="grid h-7 w-7 place-items-center rounded-md bg-white text-muted shadow-sm">
                        <Building2 className="h-3.5 w-3.5" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold leading-tight">
                          {app.role}
                        </p>
                        <p className="text-xs text-muted">{app.company}</p>
                      </div>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
