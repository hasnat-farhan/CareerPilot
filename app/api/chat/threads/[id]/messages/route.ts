import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  retrieveCvChunks,
  type Citation,
} from "@/lib/rag/retrieve-cv";
import {
  runAssistant,
  type AssistantInput,
  type AssistantResponse,
} from "@/lib/agents/assistant";

/**
 * POST /api/chat/threads/[id]/messages
 *
 * Append a user message to the thread, dispatch through the Assistant
 * intent router (`runAssistant`), and persist the model reply along
 * with its mode + structured payload.
 *
 * Request body:
 *   { content: string, intentHint?: AssistantIntent, hints?: {...} }
 *
 * The `intentHint` is set by quick-action chips in the chat UI. When
 * provided, the router skips classification and dispatches directly to
 * the matching sub-agent. Otherwise the router classifies the message
 * itself.
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

  const body = (await req.json().catch(() => ({}))) as {
    content?: string;
    intentHint?: AssistantInput["intentHint"];
    hints?: AssistantInput["hints"];
  };
  const content = body.content?.trim();
  if (!content) {
    return NextResponse.json(
      { error: "content is required" },
      { status: 400 },
    );
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
    return NextResponse.json(
      { error: insertUserErr.message },
      { status: 500 },
    );
  }

  // 3) Load the full history so the router can include context.
  const { data: historyRows, error: hErr } = await supabaseAdmin
    .from("chat_messages")
    .select("role, content")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  if (hErr) {
    return NextResponse.json({ error: hErr.message }, { status: 500 });
  }

  // 4) Dispatch through the assistant router. The router handles
  //    classification, sub-agent selection, and (for general mode)
  //    RAG retrieval. We pass the seam directly so the returned
  //    citations already carry the full Citation shape (id, source,
  //    text, score, section, sourceImageUrl) for persistence.
  let response: AssistantResponse;
  try {
    response = await runAssistant(
      {
        userId,
        message: content,
        history: (historyRows ?? []).map((r) => ({
          role: (r.role as "user" | "model") ?? "user",
          content: (r.content as string) ?? "",
        })),
        ...(body.intentHint ? { intentHint: body.intentHint } : {}),
        ...(body.hints ? { hints: body.hints } : {}),
      },
      retrieveCvChunks,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Assistant call failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // 5) Build the persistence payload. The DB column `mode` is the
  //    assistant mode (one of the five). `structured_result` is the
  //    mode-specific payload -- fit-score, roadmap, cover letter, or
  //    null for general chat (which just has citations).
  const mode = response.mode;
  const structured = extractStructured(response);
  const citations: Citation[] | null =
    response.mode === "general" && response.citations.length > 0
      ? response.citations
      : null;

  // 6) Persist the assistant reply.
  const { data: saved, error: insertModelErr } = await supabaseAdmin
    .from("chat_messages")
    .insert({
      thread_id: threadId,
      user_id: userId,
      role: "model",
      content: response.message,
      citations: citations && citations.length > 0 ? citations : null,
      mode,
      structured_result: structured,
    })
    .select("id, role, content, citations, mode, structured_result, created_at")
    .single();

  if (insertModelErr || !saved) {
    return NextResponse.json(
      { error: insertModelErr?.message ?? "Failed to save reply" },
      { status: 500 },
    );
  }

  // 7) Auto-title the thread on first exchange.
  await maybeAutoTitle(threadId, userId, content);

  return NextResponse.json({
    message: saved,
    citations: citations ?? [],
    mode,
    structured,
  });
}

// ---------- Helpers ----------

/**
 * Pull the mode-specific structured payload out of the AssistantResponse.
 * - readiness / gap_analysis: the fit-score result
 * - roadmap: the fit-score result + week count
 * - cover_letter: the fit-score result + tone + company
 * - general: null
 */
function extractStructured(
  r: AssistantResponse,
): Record<string, unknown> | null {
  switch (r.mode) {
    case "readiness":
    case "gap_analysis":
      return { fitScore: r.fitScore };
    case "roadmap":
      return { fitScore: r.fitScore, weeks: r.weeks };
    case "cover_letter":
      return {
        fitScore: r.fitScore,
        tone: r.tone,
        ...(r.company ? { company: r.company } : {}),
      };
    case "general":
      return null;
  }
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
