import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { chatComplete } from "@/lib/ai/provider";
import { retrieveCvChunks, type Citation } from "@/lib/rag/retrieve-cv";

/**
 * POST /api/chat/threads/[id]/messages
 *
 * Append a user message to the thread, generate a non-streamed model
 * reply, persist both, and return the assistant's text. Use this for
 * simple clients; for streaming, see the sibling route.
 *
 * The streaming version lives in the same file to keep the prompt
 * construction and RAG wiring in one place.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const { id: threadId } = await params;

  const body = (await req.json().catch(() => ({}))) as { content?: string };
  const content = body.content?.trim();
  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  // 1) Ownership check on the thread.
  const { data: thread, error: tErr } = await supabaseAdmin
    .from("chat_threads")
    .select("id")
    .eq("id", threadId)
    .eq("user_id", userId)
    .single();
  if (tErr || !thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  // 2) Persist the user message.
  const { error: insertUserErr } = await supabaseAdmin
    .from("chat_messages")
    .insert({ thread_id: threadId, user_id: userId, role: "user", content });
  if (insertUserErr) {
    return NextResponse.json({ error: insertUserErr.message }, { status: 500 });
  }

  // 3) Load the full history so the model has context.
  const { data: historyRows, error: hErr } = await supabaseAdmin
    .from("chat_messages")
    .select("role, content")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  if (hErr) {
    return NextResponse.json({ error: hErr.message }, { status: 500 });
  }

  // 4) RAG — fetch relevant CV chunks for the latest user turn.
  const citations: Citation[] = await retrieveCvChunks(userId, content);

  // 5) Build the prompt. System instruction carries persona + RAG chunks.
  const systemInstruction = buildSystemInstruction(citations);
  const messages = (historyRows ?? []).map((r) => ({
    role: (r.role as "user" | "model") ?? "user",
    parts: (r.content as string) ?? "",
  }));

  // 6) Call Gemini.
  let reply: string;
  try {
    reply = await chatComplete(messages, { systemInstruction });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "LLM call failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // 7) Persist the assistant reply (with citations, if any).
  const { data: saved, error: insertModelErr } = await supabaseAdmin
    .from("chat_messages")
    .insert({
      thread_id: threadId,
      user_id: userId,
      role: "model",
      content: reply,
      citations: citations.length > 0 ? citations : null,
    })
    .select("id, role, content, citations, created_at")
    .single();

  if (insertModelErr || !saved) {
    return NextResponse.json(
      { error: insertModelErr?.message ?? "Failed to save reply" },
      { status: 500 },
    );
  }

  // 8) If this is the first exchange, auto-title the thread from the user message.
  await maybeAutoTitle(threadId, userId, content);

  return NextResponse.json({ message: saved, citations });
}

function buildSystemInstruction(citations: Citation[]): string {
  const base =
    "You are CareerPilot Assistant — a sharp, action-oriented career coach. " +
    "Answer the user's question directly. If you reference their CV or background, " +
    "cite the specific chunk id in square brackets like [chunk-id]. " +
    "Keep replies under 300 words unless the user explicitly asks for depth.";

  if (citations.length === 0) return base;

  const context = citations
    .map(
      (c, i) =>
        `[${c.id}] (${c.source}, score=${c.score.toFixed(2)})\n${c.text}`,
    )
    .join("\n\n---\n\n");

  return (
    base +
    "\n\nRelevant excerpts from the user's CV:\n\n" +
    context +
    "\n\nUse the above excerpts to ground your answer. Prefer citing over inventing."
  );
}

/**
 * Set the thread's title to the first ~60 chars of the first user
 * message. Only runs if the title is still the default "New chat".
 */
async function maybeAutoTitle(
  threadId: string,
  userId: string,
  firstUserContent: string,
): Promise<void> {
  const { data: t } = await supabaseAdmin
    .from("chat_threads")
    .select("title")
    .eq("id", threadId)
    .eq("user_id", userId)
    .single();
  if (!t || t.title !== "New chat") return;

  const title = firstUserContent.replace(/\s+/g, " ").slice(0, 60).trim();
  if (!title) return;

  await supabaseAdmin
    .from("chat_threads")
    .update({ title })
    .eq("id", threadId)
    .eq("user_id", userId);
}
