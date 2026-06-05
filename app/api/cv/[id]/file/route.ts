/**
 * GET /api/cv/[id]/file
 *
 * Returns a short-lived signed URL pointing at the CV's source object
 * in the `cvs` storage bucket. The Inspector's PDF/DOCX preview iframe
 * hits this route, so the URL never has to live in the database or the
 * page bundle — and we can rotate the expiry without redeploying.
 *
 * Response (200):
 *   { url: string, expiresIn: number, mime: string, path: string }
 *
 * Response (4xx):
 *   { error: string }
 *
 * Auth: Clerk (requireUserId). Confirms the row belongs to the caller
 * before signing, then issues a URL that is only valid for `expiresIn`
 * seconds (default 5 minutes — long enough for the iframe to mount).
 *
 * Runtime: nodejs (service-role Supabase, storage client).
 */

import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth/require-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const EXPIRES_IN_SECONDS = 5 * 60;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (r) {
    return r as Response;
  }

  const { id } = await params;

  // Fetch the row but only the storage path. We refuse to sign a
  // URL for someone else's CV even though RLS would catch it.
  const { data: row, error } = await supabaseAdmin
    .from("cvs")
    .select("id, file_url, source")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "CV not found" }, { status: 404 });
  }

  const r = row as unknown as { id: string; file_url: string | null; source: string };
  if (!r.file_url) {
    return NextResponse.json(
      { error: "This CV has no source file (it was created in the builder)." },
      { status: 404 },
    );
  }

  const path = r.file_url; // we stored the storage key, not a public URL
  const mime = guessMime(path);

  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from("cvs")
    .createSignedUrl(path, EXPIRES_IN_SECONDS);

  if (signErr || !signed?.signedUrl) {
    return NextResponse.json(
      { error: signErr?.message ?? "Failed to sign URL" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    url: signed.signedUrl,
    expiresIn: EXPIRES_IN_SECONDS,
    mime,
    path,
  });
}

function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".doc")) return "application/msword";
  return "application/octet-stream";
}
