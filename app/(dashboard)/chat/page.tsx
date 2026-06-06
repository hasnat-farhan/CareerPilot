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
  Quote,
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

type AssistantMode = "readiness" | "gap_analysis" | "roadmap" | "cover_letter" | "general";

interface ScoredSkill {
  skill: string;
  level: "none" | "beginner" | "intermediate" | "advanced";
  evidence?: string;
}

interface FitScoreResult {
  band: "strong" | "moderate" | "weak";
  label: string;
  score: number;
}

type StructuredPayload = 
  | { kind: "readiness"; benchmarkTitle: string; overall: FitScoreResult; summary: string; buckets: { id: string; label: string; score: FitScoreResult; rationale: string }[] }
  | { kind: "gap_analysis"; benchmarkTitle: string; overall: FitScoreResult; summary: string; missing: { skill: string; priority: 1 | 2 | 3 | 4 | 5; reason: string; evidence?: string }[] }
  | { kind: "roadmap"; benchmarkTitle: string; weeks: number; overall: FitScoreResult; summary: string; weeks_plan: { week: number; focus: string; tasks: string[] }[] }
  | { kind: "cover_letter"; benchmarkTitle: string; company?: string; tone: "professional" | "friendly" | "enthusiastic"; summary: string; body: string };

interface Message {
  id?: string;
  role: "user" | "model";
  content: string;
  mode?: AssistantMode;
  structured?: StructuredPayload | null;
  citations?: Citation[] | null;
}

interface BenchmarkOption {
  key: string;
  title: string;
  blurb: string;
}

const BENCHMARKS: BenchmarkOption[] = [
  { key: "frontend_engineer", title: "Frontend Engineer", blurb: "React, Next.js, TypeScript, accessibility, modern styling." },
  { key: "backend_engineer", title: "Backend Engineer", blurb: "APIs, databases, queues, observability, system design." },
  { key: "data_analyst", title: "Data Analyst", blurb: "SQL, dashboards, stakeholder storytelling, business KPIs." },
  { key: "product_manager", title: "Product Manager", blurb: "Discovery, prioritisation, experimentation, cross-functional work." },
];

// ---------- Page ----------

export default function ChatPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeChip, setActiveChip] = useState<AssistantMode>("readiness");
  /**
   * The chip-panel "target role" is now a free-text input. The user can
   * either type a curated role (autocompleted from BENCHMARKS) or any
   * custom role they want. The string is matched case-insensitively
   * against BENCHMARKS first; if no match, the dynamic synthesiser
   * builds a RoleBenchmark from the free text.
   */
  const [chipRole, setChipRole] = useState<string>(BENCHMARKS[0]?.title ?? "");
  const [chipWeeks, setChipWeeks] = useState<number>(4);
  const [chipTone, setChipTone] = useState<"professional" | "friendly" | "enthusiastic">("professional");
  const [chipCompany, setChipCompany] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Initial load: list threads. If none, create one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chat/threads", { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
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
  }, []);

  // Load messages when active thread changes.
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chat/threads/" + activeId, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = (await res.json()) as {
          messages: Array<Omit<Message, "structured"> & { structured_result?: StructuredPayload | null }>;
        };
        if (cancelled) return;
        // Map DB row shape (structured_result) into the UI Message shape (structured).
        const loaded: Message[] = (json.messages ?? []).map((row) => ({
          id: row.id,
          role: row.role,
          content: row.content,
          mode: row.mode,
          structured: row.structured_result ?? null,
          citations: row.citations ?? null,
        }));
        setMessages(loaded);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Auto-scroll to bottom on new content.
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
      if (!res.ok) throw new Error("HTTP " + res.status);
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
        const res = await fetch("/api/chat/threads/" + id, { method: "DELETE" });
        if (!res.ok) throw new Error("HTTP " + res.status);
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
    async (args: { content: string; mode: AssistantMode; hints?: Record<string, unknown> }) => {
      if (!activeId || loading) return;
      setError(null);
      const userMsg: Message = { role: "user", content: args.content, mode: args.mode };
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);
      try {
        const res = await fetch("/api/chat/threads/" + activeId + "/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: args.content,
            intentHint: args.mode,
            ...(args.hints ? { hints: args.hints } : {}),
          }),
        });
        if (!res.ok) {
          const errJson = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJson.error ?? "HTTP " + res.status);
        }
        const json = (await res.json()) as { message: Message; citations: Citation[] };
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
    [activeId, loading],
  );

  const send = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || !activeId || loading) return;
      setInput("");
      await dispatch({ content: text, mode: "general" });
    },
    [input, activeId, loading, dispatch],
  );

  const chipSubmit = useCallback(() => {
    const roleText = chipRole.trim();
    if (!roleText) return;
    // Try to match a curated benchmark by title (case-insensitive).
    const benchmark = BENCHMARKS.find(
      (b) => b.title.toLowerCase() === roleText.toLowerCase(),
    );
    // If we matched a static benchmark, the assistant will use it; if
    // not, the dynamic synthesiser kicks in on the server side via
    // `hints.role`. We always send the typed text in `hints.role` so
    // the user sees the role they asked for, even if the synthesised
    // benchmark title differs slightly.
    const hints: {
      benchmarkKey?: string;
      role: string;
      weeks?: number;
      tone?: "professional" | "friendly" | "enthusiastic";
      company?: string;
    } = {
      role: roleText,
      ...(benchmark ? { benchmarkKey: benchmark.key } : {}),
      ...(activeChip === "roadmap" ? { weeks: chipWeeks } : {}),
      ...(activeChip === "cover_letter"
        ? { tone: chipTone, ...(chipCompany ? { company: chipCompany } : {}) }
        : {}),
    };
    const displayTitle = benchmark?.title ?? roleText;
    let content = "";
    switch (activeChip) {
      case "readiness":
        content = "How ready am I for the " + displayTitle + " role?";
        break;
      case "gap_analysis":
        content = "What skill gaps do I have for the " + displayTitle + " role?";
        break;
      case "roadmap":
        content = "Build me a " + chipWeeks + "-week roadmap to become a " + displayTitle + ".";
        break;
      case "cover_letter":
        content =
          "Write a " + chipTone + " cover letter for the " + displayTitle +
          " role" + (chipCompany ? " at " + chipCompany : "") + ".";
        break;
      default:
        content = "Help me with the " + displayTitle + " role.";
    }
    void dispatch({ content, mode: activeChip, hints });
  }, [activeId, loading, chipRole, chipWeeks, chipTone, chipCompany, activeChip, dispatch]);

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Sidebar */}
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

      {/* Main panel */}
      <div className="flex flex-1 flex-col rounded-2xl border border-secondary-100 bg-white shadow-card">
        <header className="flex items-center gap-2 border-b border-secondary-100 px-5 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-white">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <p className="font-heading text-sm font-semibold">CareerPilot Assistant</p>
            <p className="text-xs text-secondary-500">RAG-grounded in your CV with quick actions for each track.</p>
          </div>
        </header>

        {/* Quick action chips */}
        <div className="flex flex-wrap items-center gap-2 border-b border-secondary-100 px-5 py-3">
          <ChipButton
            active={activeChip === "readiness"}
            onClick={() => setActiveChip("readiness")}
            icon={<Compass className="h-3.5 w-3.5" />}
            label="Readiness"
          />
          <ChipButton
            active={activeChip === "gap_analysis"}
            onClick={() => setActiveChip("gap_analysis")}
            icon={<Target className="h-3.5 w-3.5" />}
            label="Skill gaps"
          />
          <ChipButton
            active={activeChip === "roadmap"}
            onClick={() => setActiveChip("roadmap")}
            icon={<CalendarRange className="h-3.5 w-3.5" />}
            label="Roadmap"
          />
          <ChipButton
            active={activeChip === "cover_letter"}
            onClick={() => setActiveChip("cover_letter")}
            icon={<Mail className="h-3.5 w-3.5" />}
            label="Cover letter"
          />
        </div>

        {/* Chip-specific panel (benchmark/weeks/tone) */}
        <ChipPanel
          mode={activeChip}
          role={chipRole}
          onRoleChange={setChipRole}
          weeks={chipWeeks}
          onWeeksChange={setChipWeeks}
          tone={chipTone}
          onToneChange={setChipTone}
          company={chipCompany}
          onCompanyChange={setChipCompany}
          onSubmit={chipSubmit}
          disabled={!activeId || loading}
        />

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((m, i) => <Bubble key={m.id ?? m.role + "-" + i} message={m} />)
          )}
          {loading && <TypingBubble />}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
        </div>

        <form onSubmit={send} className="flex items-center gap-2 border-t border-secondary-100 p-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!activeId || loading}
            type="text"
            placeholder={activeId ? "Ask anything about your job search..." : "Create a thread to start chatting..."}
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

// ---------- Sub-components ----------

function EmptyState() {
  return (
    <div className="flex max-w-2xl gap-3">
      <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-primary text-white">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="rounded-2xl rounded-tl-sm bg-secondary-50 px-4 py-3 text-sm text-secondary-700">
        Pick a quick action above (Readiness, Skill gaps, Roadmap, Cover letter) or just type a question - I will ground my answer in your CV and live web search.
      </div>
    </div>
  );
}

/**
 * Walks `content` and replaces any `[<uuid>]` markers with a clickable
 * chip. Clicking the chip scrolls the bubble's sources panel to the
 * matching citation so the user can read the full excerpt. Markers
 * whose id doesn't match a known citation fall through as plain text
 * (the model shouldn't produce those, but we don't want to crash).
 */
function renderContentWithCitations(
  content: string,
  citations: Citation[] | null | undefined,
  onCitationClick: (id: string) => void,
): React.ReactNode {
  if (!citations || citations.length === 0) return content;
  const idSet = new Set(citations.map((c) => c.id));
  const parts: React.ReactNode[] = [];
  const re = /\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let chipIndex = 0;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastIndex) parts.push(content.slice(lastIndex, m.index));
    const id = m[1]!;
    if (idSet.has(id)) {
      const cited = citations.find((c) => c.id === id);
      const sourceLabel = cited?.source ?? "source";
      const truncated = sourceLabel.length > 32 ? sourceLabel.slice(0, 32) + "…" : sourceLabel;
      parts.push(
        <button
          key={`chip-${chipIndex++}-${m.index}`}
          type="button"
          onClick={() => onCitationClick(id)}
          title={sourceLabel}
          className="mx-0.5 inline-flex items-center gap-1 align-baseline rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 text-[10px] font-medium text-primary-700 transition hover:border-primary-400 hover:bg-primary-100"
        >
          <Quote className="h-2.5 w-2.5" />
          {truncated}
        </button>,
      );
    } else {
      // Unknown id — render verbatim so we don't silently drop model output.
      parts.push(m[0]);
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < content.length) parts.push(content.slice(lastIndex));
  return parts;
}

function Bubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const sourcesRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  /**
   * Scroll the sources panel into view and pulse-highlight the matching
   * citation card. Falls back to scrolling the whole panel if the id
   * isn't found (shouldn't happen since the helper only renders chips
   * for known ids).
   */
  const scrollToSource = useCallback((id: string) => {
    const el = itemRefs.current.get(id);
    const target = el ?? sourcesRef.current;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("ring-2", "ring-primary-300");
    window.setTimeout(() => {
      target.classList.remove("ring-2", "ring-primary-300");
    }, 1400);
  }, []);

  return (
    <div className={cn("flex max-w-2xl gap-3", isUser ? "ml-auto flex-row-reverse" : "")}>
      <span
        className={cn(
          "grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg text-white",
          isUser ? "bg-secondary" : "bg-primary",
        )}
      >
        {isUser ? <span className="text-xs font-semibold">You</span> : <Bot className="h-4 w-4" />}
      </span>
      <div
        className={cn(
          "rounded-2xl px-4 py-3 text-sm",
          isUser
            ? "rounded-tr-sm bg-primary text-white"
            : "rounded-tl-sm bg-secondary-50 text-secondary-700",
        )}
      >
        {message.structured ? (
          <StructuredCard data={message.structured} />
        ) : (
          <p className="whitespace-pre-wrap leading-relaxed">
            {renderContentWithCitations(message.content, message.citations, scrollToSource)}
          </p>
        )}
        {message.citations && message.citations.length > 0 && (
          <div
            ref={sourcesRef}
            className="mt-3 space-y-2 border-t border-secondary-200 pt-2 text-xs"
          >
            <p className="font-semibold uppercase tracking-wider text-secondary-500">Sources</p>
            {message.citations.map((c) => (
              <div
                key={c.id}
                ref={(el) => {
                  if (el) itemRefs.current.set(c.id, el);
                  else itemRefs.current.delete(c.id);
                }}
                className="rounded border border-secondary-200 bg-white p-2 transition-shadow"
              >
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

function ChipButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
        active
          ? "border-primary bg-primary text-white shadow-sm"
          : "border-secondary-200 bg-white text-secondary-700 hover:border-primary/40 hover:bg-primary-50/40",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

const CHIP_TITLE: Record<AssistantMode, string> = {
  readiness: "Assess your readiness for a role",
  gap_analysis: "Find the gaps blocking a fit",
  roadmap: "Plan how to close the gaps",
  cover_letter: "Draft a tailored cover letter",
  general: "Ask anything",
};

function ChipPanel(props: {
  mode: AssistantMode;
  role: string;
  onRoleChange: (v: string) => void;
  weeks: number;
  onWeeksChange: (n: number) => void;
  tone: "professional" | "friendly" | "enthusiastic";
  onToneChange: (t: "professional" | "friendly" | "enthusiastic") => void;
  company: string;
  onCompanyChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="border-b border-secondary-100 bg-secondary-50/40 px-5 py-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-secondary-500">{CHIP_TITLE[props.mode]}</p>
      <div className="flex flex-wrap items-end gap-3">
        <RoleInput
          value={props.role}
          onChange={props.onRoleChange}
          disabled={props.disabled}
        />
        {props.mode === "roadmap" && (
          <NumberField label="Weeks" value={props.weeks} min={1} max={24} onChange={props.onWeeksChange} disabled={props.disabled} />
        )}
        {props.mode === "cover_letter" && (
          <>
            <TextField label="Company (optional)" value={props.company} onChange={props.onCompanyChange} disabled={props.disabled} placeholder="e.g. Vercel" />
            <ToneSelect value={props.tone} onChange={props.onToneChange} disabled={props.disabled} />
          </>
        )}
        <button
          type="button"
          onClick={props.onSubmit}
          disabled={props.disabled}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-primary-600 disabled:opacity-50"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Run
        </button>
      </div>
    </div>
  );
}

/**
 * Free-text role input with autocomplete over the curated BENCHMARKS list.
 * - The user can pick a known role (saves a synthesis call on the server).
 * - The user can type any other role; the server synthesises a benchmark
 *   on demand and caches it for the session.
 *
 * The datalist is intentionally suggestions-only: leaving the field
 * alone after typing keeps the typed text intact and routes to synthesis.
 */
function RoleInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs text-secondary-600 sm:max-w-xs">
      <span>Target role</span>
      <input
        type="text"
        list="cp-chip-role-suggestions"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="e.g. MLOps Engineer, Junior iOS Developer, Solutions Architect"
        className="rounded-lg border border-secondary-200 bg-white px-3 py-1.5 text-sm text-secondary-800 outline-none focus:border-primary disabled:opacity-50"
      />
      <datalist id="cp-chip-role-suggestions">
        {BENCHMARKS.map((b) => (
          <option key={b.key} value={b.title}>{b.blurb}</option>
        ))}
      </datalist>
    </label>
  );
}

function NumberField({ label, value, min, max, onChange, disabled }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-secondary-600">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        disabled={disabled}
        className="w-24 rounded-lg border border-secondary-200 bg-white px-3 py-1.5 text-sm text-secondary-800 outline-none focus:border-primary disabled:opacity-50"
      />
    </label>
  );
}

function TextField({ label, value, onChange, disabled, placeholder }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-secondary-600">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-48 rounded-lg border border-secondary-200 bg-white px-3 py-1.5 text-sm text-secondary-800 outline-none focus:border-primary disabled:opacity-50"
      />
    </label>
  );
}

function ToneSelect({ value, onChange, disabled }: { value: "professional" | "friendly" | "enthusiastic"; onChange: (t: "professional" | "friendly" | "enthusiastic") => void; disabled?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-secondary-600">
      <span>Tone</span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as "professional" | "friendly" | "enthusiastic")}
          disabled={disabled}
          className="appearance-none rounded-lg border border-secondary-200 bg-white px-3 py-1.5 pr-7 text-sm text-secondary-800 outline-none focus:border-primary disabled:opacity-50"
        >
          <option value="professional">Professional</option>
          <option value="friendly">Friendly</option>
          <option value="enthusiastic">Enthusiastic</option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-secondary-400" />
      </div>
    </label>
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

function fitTone(band: "strong" | "moderate" | "weak") {
  if (band === "strong") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (band === "moderate") return "border-amber-300 bg-amber-50 text-amber-800";
  return "border-rose-300 bg-rose-50 text-rose-800";
}

function FitPill({ score }: { score: FitScoreResult }) {
  return (
    <span
      title={score.label}
      className={cn(
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
          <div className="text-[10px] uppercase tracking-wide text-secondary-500">Readiness</div>
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
          <div className="text-[10px] uppercase tracking-wide text-secondary-500">Skill gaps</div>
          <div className="text-sm font-semibold text-secondary-900">{data.benchmarkTitle}</div>
        </div>
        <FitPill score={data.overall} />
      </div>
      <p className="text-sm text-secondary-700">{data.summary}</p>
      {data.missing.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">No major gaps detected. You look ready to apply.</div>
      ) : (
        <ul className="space-y-2">
          {data.missing.map((m) => (
            <li key={m.skill} className="rounded-lg border border-secondary-200 p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-secondary-800">{m.skill}</div>
                <span className="text-xs text-secondary-500">priority {m.priority}/5</span>
              </div>
              <p className="mt-1 text-xs text-secondary-600">{m.reason}</p>
              {m.evidence && <p className="mt-1 text-[11px] text-secondary-500">Evidence: {m.evidence}</p>}
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
          <div className="text-[10px] uppercase tracking-wide text-secondary-500">Learning roadmap</div>
          <div className="text-sm font-semibold text-secondary-900">
            {data.benchmarkTitle} <span className="text-secondary-500">in {data.weeks} weeks</span>
          </div>
        </div>
        <FitPill score={data.overall} />
      </div>
      <p className="text-sm text-secondary-700">{data.summary}</p>
      <ol className="space-y-2">
        {data.weeks_plan.map((w) => (
          <li key={w.week} className="rounded-lg border border-secondary-200 p-3">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-sm font-medium text-secondary-800">Week {w.week}</div>
              <span className="text-xs text-secondary-500">{w.focus}</span>
            </div>
            <ul className="ml-4 list-disc text-xs text-secondary-700">
              {w.tasks.map((t, i) => <li key={i}>{t}</li>)}
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
          <div className="text-[10px] uppercase tracking-wide text-secondary-500">Cover letter</div>
          <div className="text-sm font-semibold text-secondary-900">
            {data.benchmarkTitle}
            {data.company && <span className="text-secondary-500"> at {data.company}</span>}
            <span className="text-secondary-500"> - {data.tone}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(data.body)}
          className="rounded-md border border-secondary-200 px-2 py-1 text-xs text-secondary-700 hover:bg-secondary-50"
        >
          Copy
        </button>
      </div>
      <p className="text-sm text-secondary-700">{data.summary}</p>
      <pre className="whitespace-pre-wrap rounded-lg border border-secondary-200 bg-secondary-50 p-3 text-sm text-secondary-800">{data.body}</pre>
    </div>
  );
}
