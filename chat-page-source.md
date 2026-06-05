# Chat Page Source (`app/(dashboard)/chat/page.tsx`)

This is the new chat page with quick-action chips (Readiness, Skill gaps, Roadmap, Cover letter), role benchmark dropdown, weeks/tone selectors, and mode-specific structured cards.

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send,
  Sparkles,
  Bot,
  Plus,
  Trash2,
  Loader2,
  Compass,
  Target,
  CalendarRange,
  Mail,
  ChevronDown,
  Check,
  AlertCircle,
  TrendingUp,
  Lightbulb,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------- Types ----------

interface Thread {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
}

interface Citation {
  id: string;
  source: string;
  text: string;
  score: number;
}

type AssistantMode =
  | "readiness"
  | "gap_analysis"
  | "roadmap"
  | "cover_letter"
  | "general";

interface ScoredSkill {
  skill: { id: string; label: string; weight?: number; category?: string };
  matched: boolean;
  score: number;
}

interface FitScoreResult {
  score: number;
  breakdown: { skillOverlap: number; semantic: number; experience: number };
  verdict: "strong" | "good" | "borderline" | "weak";
  matched: ScoredSkill[];
  missing: ScoredSkill[];
  niceToHaveMatched: ScoredSkill[];
  experience: { inferredYears: number; requiredYears: number; education: string };
  rationale: string;
  benchmarkUsed: { key: string; title: string; summary: string };
  computedAt: string;
}

interface Message {
  id?: string;
  role: "user" | "model";
  content: string;
  citations?: Citation[] | null;
  mode?: AssistantMode | null;
  structured_result?: Record<string, unknown> | null;
}

interface BenchmarkOption {
  key: string;
  title: string;
  summary: string;
}

const BENCHMARKS: BenchmarkOption[] = [
  { key: "google-swe-intern", title: "Google SWE Intern", summary: "Python/Java/C++/DSA focus" },
  { key: "data-engineer", title: "Data Engineer", summary: "SQL, Spark, ETL, warehouses, Kafka" },
  { key: "frontend-engineer", title: "Frontend Engineer", summary: "TypeScript, React, Next.js, CSS" },
  { key: "ml-engineer", title: "ML Engineer", summary: "Python, PyTorch, ML fundamentals" },
];

export default function ChatPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Quick-action state
  const [chipOpen, setChipOpen] = useState<AssistantMode | null>(null);
  const [chipBenchmark, setChipBenchmark] = useState<string>(BENCHMARKS[0]!.key);
  const [chipWeeks, setChipWeeks] = useState<number>(6);
  const [chipTone, setChipTone] = useState<"professional" | "friendly" | "enthusiastic">(
    "professional",
  );
  const [chipCompany, setChipCompany] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chat/threads", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { threads: Thread[] };
        if (cancelled) return;
        const first = json.threads[0];
        if (!first) {
          await createThread(true);
        } else {
          setThreads(json.threads);
          setActiveId(first.id);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setSidebarLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/chat/threads/${activeId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { messages: Message[] };
        if (cancelled) setMessages(json.messages ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const createThread = useCallback(async (silent = false) => {
    if (!silent) setSidebarLoading(true);
    try {
      const res = await fetch("/api/chat/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { thread: Thread };
      setThreads((prev) => [json.thread, ...prev]);
      setActiveId(json.thread.id);
      setMessages([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create thread");
    } finally {
      if (!silent) setSidebarLoading(false);
    }
  }, []);

  const deleteThread = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/chat/threads/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setThreads((prev) => prev.filter((t) => t.id !== id));
        if (activeId === id) {
          const next = threads.find((t) => t.id !== id);
          setActiveId(next?.id ?? null);
          if (!next) await createThread(true);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete");
      }
    },
    [activeId, threads, createThread],
  );

  const dispatch = useCallback(
    async (payload: {
      content: string;
      intentHint?: AssistantMode;
      hints?: {
        benchmarkKey?: string;
        weeks?: number;
        tone?: "professional" | "friendly" | "enthusiastic";
        company?: string;
      };
    }) => {
      if (!activeId) return;
      setError(null);
      const userMsg: Message = { role: "user", content: payload.content };
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);
      try {
        const res = await fetch(`/api/chat/threads/${activeId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errJson = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJson.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          message: Message;
          citations: Citation[];
          mode: AssistantMode;
          structured: Record<string, unknown> | null;
        };
        setMessages((prev) => [...prev, json.message]);
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeId
              ? { ...t, updated_at: new Date().toISOString(), message_count: t.message_count + 2 }
              : t,
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Send failed");
        setMessages((prev) => prev.slice(0, -1));
      } finally {
        setLoading(false);
      }
    },
    [activeId],
  );

  const send = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || !activeId || loading) return;
      setInput("");
      await dispatch({ content: text });
    },
    [input, activeId, loading, dispatch],
  );

  const chipSubmit = useCallback(
    async (mode: AssistantMode) => {
      if (!activeId || loading) return;
      const benchmarkTitle =
        BENCHMARKS.find((b) => b.key === chipBenchmark)?.title ?? "this role";
      let prompt = "";
      const hints: {
        benchmarkKey: string;
        weeks: number;
        tone: "professional" | "friendly" | "enthusiastic";
        company?: string;
      } = {
        benchmarkKey: chipBenchmark,
        weeks: chipWeeks,
        tone: chipTone,
        ...(chipCompany.trim() ? { company: chipCompany.trim() } : {}),
      };
      switch (mode) {
        case "readiness":
          prompt = `Am I ready for a ${benchmarkTitle} role?`;
          break;
        case "gap_analysis":
          prompt = `What am I missing for a ${benchmarkTitle} role, and how do I close the gaps?`;
          break;
        case "roadmap":
          prompt = `Build me a ${chipWeeks}-week plan to become a ${benchmarkTitle}.`;
          break;
        case "cover_letter":
          prompt = chipCompany.trim()
            ? `Draft a ${chipTone} cover letter for a ${benchmarkTitle} role at ${chipCompany.trim()}.`
            : `Draft a ${chipTone} cover letter for a ${benchmarkTitle} role.`;
          break;
        case "general":
          prompt = "Free chat - fall through to the general assistant.";
          break;
      }
      setChipOpen(null);
      await dispatch({ content: prompt, intentHint: mode, hints });
    },
    [activeId, loading, chipBenchmark, chipWeeks, chipTone, chipCompany, dispatch],
  );

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      <aside className="hidden w-64 flex-shrink-0 flex-col rounded-2xl border border-secondary-100 bg-white shadow-card md:flex">
        <div className="flex items-center justify-between border-b border-secondary-100 p-3">
          <p className="font-heading text-sm font-semibold">Threads</p>
          <button
            type="button"
            onClick={() => createThread()}
            className="grid h-7 w-7 place-items-center rounded-md text-secondary-500 transition hover:bg-primary-50 hover:text-primary"
            aria-label="New thread"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sidebarLoading ? (
            <div className="flex justify-center py-6 text-secondary-400">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : threads.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-secondary-400">No threads yet.</p>
          ) : (
            threads.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveId(t.id)}
                className={cn(
                  "group flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition",
                  activeId === t.id
                    ? "bg-primary-50 text-primary"
                    : "text-secondary-700 hover:bg-secondary-50",
                )}
              >
                <span className="truncate">
                  {t.title}
                  {t.message_count > 0 && (
                    <span className="ml-1 text-xs text-secondary-400">({t.message_count})</span>
                  )}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("Delete this thread?")) void deleteThread(t.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (confirm("Delete this thread?")) void deleteThread(t.id);
                    }
                  }}
                  className="hidden h-6 w-6 flex-shrink-0 cursor-pointer place-items-center rounded text-secondary-400 hover:bg-red-50 hover:text-red-600 group-hover:flex"
                  aria-label="Delete thread"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="flex flex-1 flex-col rounded-2xl border border-secondary-100 bg-white shadow-card">
        <header className="flex items-center gap-2 border-b border-secondary-100 px-5 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-white">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <p className="font-heading text-sm font-semibold">CareerPilot Assistant</p>
            <p className="text-xs text-secondary-500">
              RAG-grounded in your CV, with quick-actions for readiness, gaps, roadmaps &amp; cover letters.
            </p>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((m, i) => (
              <Bubble key={m.id ?? `${m.role}-${i}`} message={m} />
            ))
          )}
          {loading && <TypingBubble />}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="border-t border-secondary-100 px-3 pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <ChipButton
              icon={<Compass className="h-3.5 w-3.5" />}
              label="Readiness"
              active={chipOpen === "readiness"}
              onClick={() => setChipOpen(chipOpen === "readiness" ? null : "readiness")}
            />
            <ChipButton
              icon={<Target className="h-3.5 w-3.5" />}
              label="Skill gaps"
              active={chipOpen === "gap_analysis"}
              onClick={() => setChipOpen(chipOpen === "gap_analysis" ? null : "gap_analysis")}
            />
            <ChipButton
              icon={<CalendarRange className="h-3.5 w-3.5" />}
              label="Roadmap"
              active={chipOpen === "roadmap"}
              onClick={() => setChipOpen(chipOpen === "roadmap" ? null : "roadmap")}
            />
            <ChipButton
              icon={<Mail className="h-3.5 w-3.5" />}
              label="Cover letter"
              active={chipOpen === "cover_letter"}
              onClick={() => setChipOpen(chipOpen === "cover_letter" ? null : "cover_letter")}
            />
          </div>
          {chipOpen && (
            <ChipPanel
              mode={chipOpen}
              benchmark={chipBenchmark}
              setBenchmark={setChipBenchmark}
              weeks={chipWeeks}
              setWeeks={setChipWeeks}
              tone={chipTone}
              setTone={setChipTone}
              company={chipCompany}
              setCompany={setChipCompany}
              onSubmit={() => void chipSubmit(chipOpen)}
              onClose={() => setChipOpen(null)}
            />
          )}
        </div>

        <form onSubmit={send} className="flex items-center gap-2 border-t border-secondary-100 p-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!activeId || loading}
            type="text"
            placeholder={
              activeId
                ? "Ask anything - or use a quick-action chip above."
                : "Create a thread to start chatting..."
            }
            className="flex-1 rounded-lg border border-secondary-100 bg-secondary-50/40 px-3 py-2 text-sm outline-none focus:border-primary focus:bg-white disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!activeId || loading || !input.trim()}
            className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-white transition hover:bg-primary-600 disabled:opacity-50"
            aria-label="Send"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex max-w-2xl gap-3">
      <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-primary text-white">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="rounded-2xl rounded-tl-sm bg-secondary-50 px-4 py-3 text-sm text-secondary-700">
        Ask me anything about your job search - I&apos;ll cite the CV chunks I use to answer.
        For faster results, try one of the quick-actions: <b>Readiness</b>, <b>Skill gaps</b>,
        <b> Roadmap</b>, or <b>Cover letter</b>.
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const mode = message.mode ?? "general";
  return (
    <div className="flex max-w-2xl gap-3">
      <span
        className={cn(
          "grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg text-white",
          isUser ? "bg-secondary ml-auto" : "bg-primary",
        )}
      >
        {isUser ? <span className="text-xs font-semibold">You</span> : <Bot className="h-4 w-4" />      </span>
      <div
        className={cn(
          "rounded-2xl px-4 py-3 text-sm",
          isUser
            ? "ml-auto rounded-tr-sm bg-primary text-white"
            : "rounded-tl-sm bg-secondary-50 text-secondary-700",
        )}
      >
        {message.content && <p className="whitespace-pre-wrap">{message.content}</p>}
        {!isUser && mode !== "general" && message.structured_result && (
          <StructuredCard mode={mode} data={message.structured_result} />
        )}
        {message.citations && message.citations.length > 0 && (
          <div className="mt-3 space-y-2 border-t border-secondary-200 pt-2 text-xs">
            <p className="font-semibold uppercase tracking-wider text-secondary-500">Citations</p>
            {message.citations.map((c) => (
              <div key={c.id} className="rounded border border-secondary-200 bg-white p-2">
                <p className="font-medium text-secondary-700">{c.source}</p>
                <p className="text-secondary-500">{c.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex max-w-2xl gap-3">
      <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-primary text-white">
        <Bot className="h-4 w-4" />
      </span>
      <div className="rounded-2xl rounded-tl-sm bg-secondary-50 px-4 py-3 text-sm text-secondary-700">
        <Loader2 className="h-4 w-4 animate-spin text-secondary-400" />
      </div>
    </div>
  );
}

function ChipButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
        active
          ? "border-primary bg-primary text-white"
          : "border-secondary-200 bg-white text-secondary-700 hover:border-primary/40 hover:bg-primary-50",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

const CHIP_TITLE: Record<AssistantMode, string> = {
  readiness: "Check your readiness for a role",
  gap_analysis: "Find skill gaps for a role",
  roadmap: "Build a learning roadmap",
  cover_letter: "Draft a cover letter",
  general: "Free chat",
};


function ChipPanel({
  mode,
  benchmark,
  setBenchmark,
  weeks,
  setWeeks,
  tone,
  setTone,
  company,
  setCompany,
  onSubmit,
  onClose,
}: {
  mode: AssistantMode;
  benchmark: string;
  setBenchmark: (v: string) => void;
  weeks: number;
  setWeeks: (v: number) => void;
  tone: "professional" | "friendly" | "enthusiastic";
  setTone: (v: "professional" | "friendly" | "enthusiastic") => void;
  company: string;
  setCompany: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mb-3 rounded-xl border border-secondary-100 bg-secondary-50/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-secondary-500">
          {CHIP_TITLE[mode]}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-secondary-400 hover:text-secondary-700"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {(mode === "readiness" ||
          mode === "gap_analysis" ||
          mode === "roadmap" ||
          mode === "cover_letter") && (
          <BenchmarkSelect value={benchmark} onChange={setBenchmark} />
        )}
        {mode === "roadmap" && (
          <NumberField label="Weeks" value={weeks} onChange={setWeeks} min={1} max={24} />
        )}
        {mode === "cover_letter" && (
          <>
            <ToneSelect value={tone} onChange={setTone} />
            <TextField label="Company (optional)" value={company} onChange={setCompany} />
          </>
        )}
        <button
          type="button"
          onClick={onSubmit}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white transition hover:bg-primary-600"
        >
          <Check className="h-3.5 w-3.5" />
          Run
        </button>
      </div>
    </div>
  );
}


function BenchmarkSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = BENCHMARKS.find((b) => b.key === value) ?? BENCHMARKS[0]!;
  return (
    <div className="relative">
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-secondary-500">
        Role
      </label>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-secondary-200 bg-white px-2.5 py-1.5 text-xs text-secondary-700 hover:border-primary/40"
      >
        {current.title}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-64 overflow-hidden rounded-lg border border-secondary-200 bg-white shadow-lg">
          {BENCHMARKS.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => {
                onChange(b.key);
                setOpen(false);
              }}
              className={cn(
                "block w-full px-3 py-2 text-left text-xs transition hover:bg-primary-50",
                b.key === value ? "bg-primary-50 text-primary" : "text-secondary-700",
              )}
            >
              <p className="font-medium">{b.title}</p>
              <p className="text-[10px] text-secondary-500">{b.summary}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-secondary-500">
        {label}
      </label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        className="w-20 rounded-lg border border-secondary-200 bg-white px-2.5 py-1.5 text-xs text-secondary-700 outline-none focus:border-primary"
      />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-secondary-500">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Acme Corp"
        className="w-48 rounded-lg border border-secondary-200 bg-white px-2.5 py-1.5 text-xs text-secondary-700 outline-none focus:border-primary"
      />
    </div>
  );
}

function ToneSelect({
  value,
  onChange,
}: {
  value: "professional" | "friendly" | "enthusiastic";
  onChange: (v: "professional" | "friendly" | "enthusiastic") => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-secondary-500">
        Tone
      </label>
      <select
        value={value}
        onChange={(e) =>
          onChange(e.target.value as "professional" | "friendly" | "enthusiastic")
        }
        className="rounded-lg border border-secondary-200 bg-white px-2.5 py-1.5 text-xs text-secondary-700 outline-none focus:border-primary"
      >
        <option value="professional">Professional</option>
        <option value="friendly">Friendly</option>
        <option value="enthusiastic">Enthusiastic</option>
      </select>
    </div>
  );
}


function StructuredCard({ data }: { data: NonNullable<Message["structured"]> }) {
  switch (data.kind) {
    case "readiness":
      return <ReadinessCard data={data} />;
    case "gap_analysis":
      return <GapCard data={data} />;
    case "roadmap":
      return <RoadmapCard data={data} />;
    case "cover_letter":
      return <CoverCard data={data} />;
    default:
      return null;
  }
}

function FitPill({ score }: { score: { band: "strong" | "moderate" | "weak"; label: string } }) {
  return (
    <span
      title={score.label}
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        fitTone(score.band),
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {score.label}
    </span>
  );
}

function ReadinessCard({ data }: { data: Extract<NonNullable<Message["structured"]>, { kind: "readiness" }> }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-secondary-500">Readiness</div>
          <div className="text-sm font-semibold text-secondary-900">{data.benchmarkTitle}</div>
        </div>
        <FitPill score={data.overall} />
      </div>
      <p className="text-sm text-secondary-700">{data.summary}</p>
      {data.buckets.map((b) => (
        <div key={b.id} className="rounded-lg border border-secondary-200 p-3">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-sm font-medium text-secondary-800">{b.label}</div>
            <FitPill score={b.score} />
          </div>
          <p className="text-xs text-secondary-600">{b.rationale}</p>
        </div>
      ))}
    </div>
  );
}

function GapCard({ data }: { data: Extract<NonNullable<Message["structured"]>, { kind: "gap_analysis" }> }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-secondary-500">Skill gaps</div>
          <div className="text-sm font-semibold text-secondary-900">{data.benchmarkTitle}</div>
        </div>
        <FitPill score={data.overall} />
      </div>
      <p className="text-sm text-secondary-700">{data.summary}</p>
      {data.missing.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          No major gaps detected. You look ready to apply.
        </div>
      ) : (
        <ul className="space-y-2">
          {data.missing.map((m) => (
            <li key={m.skill} className="rounded-lg border border-secondary-200 p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-secondary-800">{m.skill}</div>
                <span className="text-xs text-secondary-500">priority {m.priority}/5</span>
              </div>
              <p className="mt-1 text-xs text-secondary-600">{m.reason}</p>
              {m.evidence && (
                <p className="mt-1 text-[11px] text-secondary-500">Evidence: {m.evidence}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoadmapCard({ data }: { data: Extract<NonNullable<Message["structured"]>, { kind: "roadmap" }> }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-secondary-500">Learning roadmap</div>
          <div className="text-sm font-semibold text-secondary-900">
            {data.benchmarkTitle} <span className="text-secondary-500">in {data.weeks} weeks</span>
          </div>
        </div>
        <FitPill score={data.overall} />
      </div>
      <p className="text-sm text-secondary-700">{data.summary}</p>
      <ol className="space-y-2">
        {data.weeks.map((w) => (
          <li key={w.week} className="rounded-lg border border-secondary-200 p-3">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-sm font-medium text-secondary-800">Week {w.week}</div>
              <span className="text-xs text-secondary-500">{w.focus}</span>
            </div>
            <ul className="ml-4 list-disc text-xs text-secondary-700">
              {w.tasks.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function CoverCard({ data }: { data: Extract<NonNullable<Message["structured"]>, { kind: "cover_letter" }> }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-secondary-500">Cover letter</div>
          <div className="text-sm font-semibold text-secondary-900">
            {data.benchmarkTitle}
            {data.company && <span className="text-secondary-500"> at {data.company}</span>}
            <span className="text-secondary-500"> - {data.tone}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={function () { navigator.clipboard.writeText(data.body); }}
          className="rounded-md border border-secondary-200 px-2 py-1 text-xs text-secondary-700 hover:bg-secondary-50"
        >
          Copy
        </button>
      </div>
      <p className="text-sm text-secondary-700">{data.summary}</p>
      <pre className="whitespace-pre-wrap rounded-lg border border-secondary-200 bg-secondary-50 p-3 text-sm text-secondary-800">
{data.body}
</pre>
    </div>
  );
}

```

## API contract used by this page

`POST /api/chat/threads/:id/messages`

Request:

```json
{ "content": "string", "intentHint": "readiness | gap_analysis | roadmap | cover_letter | general" }
```

Response (streamed NDJSON, Vercel AI SDK data protocol):

```json
{ "role": "assistant", "content": "string", "structured": { ... }, "citations": [ ... ] }
```

`structured.kind` is one of `readiness | gap_analysis | roadmap | cover_letter`. The four card components above are pure projections of those payloads.

## Benchmark keys

| Key | Title | Why it is here |
| --- | --- | --- |
| `frontend_engineer` | Frontend Engineer | Most common first job target for this cohort |
| `backend_engineer` | Backend Engineer | Pairs with FE for full-stack readiness flows |
| `data_analyst` | Data Analyst | Bridges CareerPilot analytics + business outcomes |
| `product_manager` | Product Manager | Non-engineering track to validate multi-role UI |

Add more by dropping a `BenchmarkOption` entry into `lib/data/benchmarks/index.ts` and exporting it in the `BENCHMARKS` array used by this page.
