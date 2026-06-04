"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Sparkles, Bot, Plus, Trash2, Loader2 } from "lucide-react";
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

interface Message {
  id?: string;
  role: "user" | "model";
  content: string;
  citations?: Citation[] | null;
}

// ---------- Page ----------

export default function ChatPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Initial load: list threads. If none, create one.
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
        const res = await fetch(`/api/chat/threads/${activeId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { messages: Message[] };
        if (!cancelled) setMessages(json.messages ?? []);
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

  const send = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || !activeId || loading) return;

      setError(null);
      const userMsg: Message = { role: "user", content: text };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setLoading(true);

      try {
        const res = await fetch(`/api/chat/threads/${activeId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: text }),
        });
        if (!res.ok) {
          const errJson = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJson.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as { message: Message; citations: Citation[] };
        setMessages((prev) => [...prev, json.message]);
        // Bump the thread to the top of the sidebar.
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeId
              ? { ...t, updated_at: new Date().toISOString(), message_count: t.message_count + 2 }
              : t,
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Send failed");
        // Remove the optimistic user message so the user can retry.
        setMessages((prev) => prev.slice(0, -1));
      } finally {
        setLoading(false);
      }
    },
    [input, activeId, loading],
  );

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
            <p className="text-xs text-secondary-500">
              RAG-grounded in your CV, with live web search.
            </p>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((m, i) => <Bubble key={m.id ?? `${m.role}-${i}`} message={m} />)
          )}
          {loading && <TypingBubble />}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
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
                ? "e.g. Which roles fit my Next.js + Supabase experience?"
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

// ---------- Sub-components ----------

function EmptyState() {
  return (
    <div className="flex max-w-2xl gap-3">
      <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-primary text-white">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="rounded-2xl rounded-tl-sm bg-secondary-50 px-4 py-3 text-sm text-secondary-700">
        Ask me anything about your job search — I&apos;ll cite the CV chunks I use to answer.
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
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
        <p className="whitespace-pre-wrap">{message.content}</p>
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
