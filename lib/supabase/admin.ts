import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. Bypasses RLS.
 *
 * SERVER-ONLY. Never import this from a `"use client"` component or any
 * code that ships to the browser — it would leak the service-role key.
 *
 * The API routes at `app/api/chat/*` use this client to read/write
 * `chat_threads` and `chat_messages` on behalf of the authenticated Clerk
 * user. They manually enforce `user_id = <clerk userId>` in every query
 * since RLS is bypassed by design here.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  // Throw lazily: importing this module on the server at boot is fine,
  // but the message is loud enough that a missing env var is obvious.
  // eslint-disable-next-line no-console
  console.warn(
    "[supabase/admin] Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL. " +
      "Server-side chat persistence will fail until .env.local is filled in.",
  );
}

export const supabaseAdmin = createClient(url ?? "", serviceKey ?? "", {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
