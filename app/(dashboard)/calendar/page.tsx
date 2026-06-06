"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, Circle, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Application, Todo } from "@/lib/productivity/types";

type DayItem = { kind: "todo"; todo: Todo } | { kind: "app"; app: Application };

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function buildMonthGrid(view: Date) {
  const first = firstOfMonth(view);
  const startOffset = (first.getDay() + 6) % 7; // 0 = Mon
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startOffset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
}

export default function CalendarPage() {
  const [view, setView] = useState<Date>(() => new Date());
  const [selected, setSelected] = useState<string>(() => todayISO());
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [apps, setApps] = useState<Application[] | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const from = new Date(view.getFullYear(), view.getMonth() - 1, 1)
      .toISOString()
      .slice(0, 10);
    const to = new Date(view.getFullYear(), view.getMonth() + 2, 0)
      .toISOString()
      .slice(0, 10);
    const [tRes, aRes] = await Promise.all([
      fetch(`/api/todos?from=${from}&to=${to}`, { cache: "no-store" }),
      fetch(`/api/tracker/applications`, { cache: "no-store" }),
    ]);
    const tJson = tRes.ok ? ((await tRes.json()) as { todos: Todo[] }) : { todos: [] };
    const aJson = aRes.ok
      ? ((await aRes.json()) as { applications: Application[] })
      : { applications: [] };
    setTodos(tJson.todos);
    setApps(aJson.applications);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.getFullYear(), view.getMonth()]);

  const byDate = useMemo(() => {
    const m = new Map<string, DayItem[]>();
    for (const t of todos ?? []) {
      if (!t.due_date) continue;
      const list = m.get(t.due_date) ?? [];
      list.push({ kind: "todo", todo: t });
      m.set(t.due_date, list);
    }
    for (const a of apps ?? []) {
      if (!a.deadline) continue;
      const list = m.get(a.deadline) ?? [];
      list.push({ kind: "app", app: a });
      m.set(a.deadline, list);
    }
    return m;
  }, [todos, apps]);

  const grid = useMemo(() => buildMonthGrid(view), [view]);

  const selectedItems = byDate.get(selected) ?? [];

  async function addTodo() {
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim(), due_date: selected }),
      });
      if (res.ok) {
        setNewTitle("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleTodo(t: Todo) {
    setBusy(true);
    try {
      const res = await fetch(`/api/todos/${t.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: !t.done }),
      });
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  async function deleteTodo(t: Todo) {
    setBusy(true);
    try {
      const res = await fetch(`/api/todos/${t.id}`, { method: "DELETE" });
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container-wide space-y-8 py-10 md:py-14">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Calendar &amp; to-dos.
        </h1>
        <p className="mt-1 text-sm text-secondary-500">
          Deadlines and goals, all in one timeline.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <article className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />
              <h2 className="font-heading text-sm font-semibold">
                {view.toLocaleString("en-US", { month: "long", year: "numeric" })}
              </h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))
                }
                className="rounded-lg border border-secondary-100 px-2 py-1 text-xs hover:bg-secondary-50"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => setView(new Date())}
                className="rounded-lg border border-secondary-100 px-2 py-1 text-xs hover:bg-secondary-50"
              >
                Today
              </button>
              <button
                type="button"
                onClick={() =>
                  setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))
                }
                className="rounded-lg border border-secondary-100 px-2 py-1 text-xs hover:bg-secondary-50"
              >
                ›
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-xs">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <span key={d} className="py-1 font-semibold text-secondary-400">
                {d}
              </span>
            ))}
            {grid.map((d) => {
              const key = d.toISOString().slice(0, 10);
              const inMonth = d.getMonth() === view.getMonth();
              const items = byDate.get(key) ?? [];
              const isSelected = key === selected;
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => setSelected(key)}
                  className={cn(
                    "relative aspect-square rounded-md border p-1 text-left text-xs",
                    isSelected
                      ? "border-primary bg-primary-50/60"
                      : "border-transparent",
                    inMonth
                      ? "text-secondary-700 hover:border-primary-100 hover:bg-primary-50/40"
                      : "text-secondary-300",
                  )}
                >
                  <span className="block">{d.getDate()}</span>
                  {items.length > 0 && (
                    <span className="absolute bottom-1 right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-white">
                      {items.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </article>

        <article className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
          <h2 className="font-heading text-sm font-semibold">
            {selected === todayISO() ? "Today" : selected}
          </h2>
          <ul className="mt-3 space-y-2">
            {selectedItems.length === 0 && (
              <li className="rounded-lg border border-dashed border-secondary-200 p-3 text-center text-xs text-secondary-400">
                Nothing scheduled.
              </li>
            )}
            {selectedItems.map((it) =>
              it.kind === "todo" ? (
                <li
                  key={`t-${it.todo.id}`}
                  className="flex items-start gap-2 rounded-lg border border-secondary-100 bg-secondary-50/40 p-2.5"
                >
                  <button
                    type="button"
                    onClick={() => void toggleTodo(it.todo)}
                    className="mt-0.5"
                    disabled={busy}
                    aria-label="Toggle done"
                  >
                    {it.todo.done ? (
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                    ) : (
                      <Circle className="h-4 w-4 text-secondary-300" />
                    )}
                  </button>
                  <span
                    className={cn(
                      "flex-1 text-sm",
                      it.todo.done
                        ? "text-secondary-400 line-through"
                        : "text-secondary-700",
                    )}
                  >
                    {it.todo.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => void deleteTodo(it.todo)}
                    className="text-secondary-300 hover:text-rose-500"
                    aria-label="Delete"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ) : (
                <li
                  key={`a-${it.app.id}`}
                  className="flex items-start gap-2 rounded-lg border border-secondary-100 bg-primary-50/40 p-2.5"
                >
                  <span className="mt-0.5 h-2 w-2 flex-shrink-0 rounded-full bg-primary" />
                  <span className="flex-1 text-sm text-secondary-700">
                    <span className="font-semibold">{it.app.role}</span>
                    <span className="text-secondary-500"> @ {it.app.company}</span>
                    <span className="ml-2 text-xs uppercase tracking-wider text-primary">
                      {it.app.status}
                    </span>
                  </span>
                </li>
              ),
            )}
          </ul>

          <div className="mt-4 flex items-center gap-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addTodo();
              }}
              placeholder="Add a to-do…"
              className="flex-1 rounded-lg border border-secondary-100 px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void addTodo()}
              disabled={busy || !newTitle.trim()}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}
