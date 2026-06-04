import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const createClient = (request: NextRequest) => {
  // Create an unmodified response we can attach refreshed cookies to.
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  // Touch the server client so it can read cookies; we don't need the
  // returned instance to expose the response — we only need its side
  // effect of writing refreshed cookies via setAll().
  createServerClient(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Forward refreshed cookies onto both the incoming request (so
        // RSC sees them in the same pass) and the outgoing response
        // (so the browser persists them).
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  return supabaseResponse;
};
