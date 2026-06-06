"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  APPLICATION_STATUSES,
  type Application,
  type ApplicationStatus,
} from "@/lib/productivity/types";

const columns: { id: ApplicationStatus; title: string; accent: string }[] = [
  { id: "applied", title: "Applied", accent: "bg-secondary-100" },
  { id: "interviewing", title: "Interviewing", accent: "bg-primary-100" },
  { id: "offer", title: "Offer", accent: "bg-emerald-100" },
  { id: "rejected", title: "Rejected", accent: "bg-rose-100" },
];

export default function TrackerPage() {
  const [apps, setApps] = useState<Application[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<ApplicationStatus | null>(null);
  const [selected, setSelected] = useState<Application | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/tracker/applications", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { applications: Application[] };
      setApps(json.applications ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const grouped = useMemo(() => {
    const g: Record<ApplicationStatus, Application[]> = {
      applied: [],
      interviewing: [],
      offer: [],
      rejected: [],
    };
    for (const a of apps ?? []) g[a.status]?.push(a);
    return g;
  }, [apps]);

  async function moveTo(id: string, status: ApplicationStatus) {
    setError(null);
    // Optimistic update
    setApps((prev) =>
      (prev ?? []).map((a) => (a.id === id ? { ...a, status } : a)),
    );
    try {
      const res = await fetch(`/api/tracker/applications/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { application: Application };
      setApps((prev) =>
        (prev ?? []).map((a) => (a.id === id ? json.application : a)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Move failed");
      void load(); // roll back
    }
  }

  async function deleteApp(id: string) {
    setError(null);
    setSelected(null);
    setApps((prev) => (prev ?? []).filter((a) => a.id !== id));
    try {
      const res = await fetch(`/api/tracker/applications/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      void load();
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Your pipeline, at a glance.
        </h1>
        <p className="mt-1 text-sm text-secondary-500">
          Drag cards across columns to update their status.
        </p>
        {error && (
          <p className="mt-2 text-xs text-rose-600">{error}</p>
        )}
      </div>

      {apps === null ? (
        <p className="text-sm text-secondary-400">Loading…</p>
      ) : apps.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-secondary-200 bg-white p-8 text-center text-sm text-secondary-500">
          No applications yet. Apply to a job from{" "}
          <a href="/hunter" className="text-primary hover:underline">
            Job Hunter
          </a>{" "}
          and it will appear here.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {columns.map((col) => (
            <section
              key={col.id}
              onDragOver={(e) => {
                e.preventDefault();
                setOverCol(col.id);
              }}
              onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setOverCol(null);
                const id = e.dataTransfer.getData("text/plain");
                if (id) void moveTo(id, col.id);
                setDraggingId(null);
              }}
              className={cn(
                "rounded-2xl border bg-white p-4 shadow-card transition",
                overCol === col.id
                  ? "border-primary-300 ring-2 ring-primary-100"
                  : "border-secondary-100",
              )}
            >
              <header className="mb-3 flex items-center justify-between">
                <h2 className="font-heading text-sm font-semibold">{col.title}</h2>
                <span
                  className={cn(
                    "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold",
                    col.accent,
                  )}
                >
                  {grouped[col.id].length}
                </span>
              </header>
              <div className="space-y-2">
                {grouped[col.id].length === 0 ? (
                  <p className="rounded-lg border border-dashed border-secondary-200 p-4 text-center text-xs text-secondary-400">
                    Drop a card here.
                  </p>
                ) : (
                  grouped[col.id].map((app) => (
                    <article
                      key={app.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", app.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDraggingId(app.id);
                      }}
                      onDragEnd={() => setDraggingId(null)}
                      onClick={() => setSelected(app)}
                      className={cn(
                        "cursor-grab rounded-lg border border-secondary-100 bg-secondary-50/40 p-3 transition hover:border-primary hover:bg-white active:cursor-grabbing",
                        draggingId === app.id && "opacity-50",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="grid h-7 w-7 place-items-center rounded-md bg-white text-secondary-500 shadow-sm">
                          <Building2 className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold leading-tight">
                            {app.role}
                          </p>
                          <p className="truncate text-xs text-secondary-500">
                            {app.company}
                          </p>
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {selected && (
        <DetailPanel
          app={selected}
          onClose={() => setSelected(null)}
          onDelete={() => void deleteApp(selected.id)}
          onMove={(status) => {
            void moveTo(selected.id, status);
            setSelected((s) => (s ? { ...s, status } : s));
          }}
        />
      )}
    </div>
  );
}

function DetailPanel({
  app,
  onClose,
  onDelete,
  onMove,
}: {
  app: Application;
  onClose: () => void;
  onDelete: () => void;
  onMove: (s: ApplicationStatus) => void;
}) {
  return (
    <div className="fixed inset-0 z-20 flex items-stretch justify-end bg-black/30">
      <div className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-secondary-400">
              {app.company}
            </p>
            <h2 className="font-heading text-xl font-bold">{app.role}</h2>
            {app.location && (
              <p className="mt-1 text-sm text-secondary-500">{app.location}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-secondary-400 hover:bg-secondary-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
          {app.salary && (
            <div>
              <p className="text-secondary-400">Salary</p>
              <p className="font-medium">{app.salary}</p>
            </div>
          )}
          {app.deadline && (
            <div>
              <p className="text-secondary-400">Deadline</p>
              <p className="font-medium">{app.deadline}</p>
            </div>
          )}
          {app.url && (
            <div className="col-span-2">
              <p className="text-secondary-400">Link</p>
              <a
                href={app.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-primary hover:underline"
              >
                {app.url}
              </a>
            </div>
          )}
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-secondary-400">
            Move to
          </p>
          <div className="grid grid-cols-2 gap-2">
            {APPLICATION_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={s === app.status}
                onClick={() => onMove(s)}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-xs font-semibold capitalize",
                  s === app.status
                    ? "border-primary-200 bg-primary-50 text-primary"
                    : "border-secondary-100 text-secondary-600 hover:border-primary-200 hover:bg-primary-50",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-secondary-400">
            History
          </p>
          {app.history.length === 0 ? (
            <p className="text-xs text-secondary-400">No moves yet.</p>
          ) : (
            <ol className="space-y-1 text-xs text-secondary-600">
              {app.history.map((h, i) => (
                <li key={i} className="flex justify-between">
                  <span className="capitalize">{h.status}</span>
                  <span>{new Date(h.at).toLocaleString()}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <button
          type="button"
          onClick={onDelete}
          className="w-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100"
        >
          Delete application
        </button>
      </div>
    </div>
  );
}
