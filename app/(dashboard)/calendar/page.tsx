import { CalendarDays, CheckCircle2, Circle } from "lucide-react";

const todos = [
  { id: 1, title: "Follow up with Sheba.xyz recruiter", done: false },
  { id: 2, title: "Submit take-home for bKash", done: false },
  { id: 3, title: "Update LinkedIn headline", done: true },
  { id: 4, title: "Prep for Pathao system design round", done: false },
];

export default function CalendarPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Calendar &amp; to-dos.
        </h1>
        <p className="mt-1 text-sm text-muted">
          Deadlines and goals, all in one timeline.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <article className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card lg:col-span-2">
          <div className="mb-4 flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-primary" />
            <h2 className="font-heading text-sm font-semibold">This month</h2>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-xs">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <span key={d} className="py-1 font-semibold text-muted">
                {d}
              </span>
            ))}
            {Array.from({ length: 35 }).map((_, i) => {
              const day = i - 1;
              const inMonth = day > 0 && day <= 30;
              const hasEvent = [3, 8, 14, 21, 27].includes(day);
              return (
                <div
                  key={i}
                  className={[
                    "relative aspect-square rounded-md border border-transparent p-1 text-xs",
                    inMonth
                      ? "text-secondary-700 hover:border-primary-100 hover:bg-primary-50/40"
                      : "text-muted",
                  ].join(" ")}
                >
                  {inMonth ? day : ""}
                  {hasEvent && (
                    <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-primary" />
                  )}
                </div>
              );
            })}
          </div>
        </article>

        <article className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
          <h2 className="font-heading text-sm font-semibold">Today&apos;s to-dos</h2>
          <ul className="mt-3 space-y-2">
            {todos.map((t) => (
              <li
                key={t.id}
                className="flex items-start gap-2 rounded-lg border border-secondary-100 bg-surface/40 p-2.5"
              >
                {t.done ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                ) : (
                  <Circle className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted" />
                )}
                <span
                  className={
                    t.done
                      ? "text-sm text-muted line-through"
                      : "text-sm text-secondary-700"
                  }
                >
                  {t.title}
                </span>
              </li>
            ))}
          </ul>
        </article>
      </div>
    </div>
  );
}
