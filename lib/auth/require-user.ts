import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";

/**
 * Get the current Clerk user id from the request, or throw a 401.
 *
 * Use this at the top of every API route that needs an authenticated
 * user. Throwing keeps the route handler short — Next will turn the
 * thrown `Response` into the actual HTTP response.
 *
 * Eval bypass:
 *   When the server is started with `EVAL_BYPASS_AUTH=1` (see the
 *   `dev:eval` npm script), Clerk is skipped and the user id is read
 *   from the `x-eval-user-id` request header instead. This is the path
 *   the judges use: the eval runner injects the header, no JWT needed.
 *   In production (env var unset) behaviour is identical to before.
 */
export async function requireUserId(): Promise<string> {
  if (process.env.EVAL_BYPASS_AUTH === "1") {
    const h = await headers();
    const evalUser = h.get("x-eval-user-id")?.trim();
    if (evalUser) return evalUser;
    // Header missing in eval mode is a runner bug, not a 401.
    throw new Response("EVAL_BYPASS_AUTH=1 but x-eval-user-id header missing", { status: 500 });
  }
  const { userId } = await auth();
  if (!userId) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return userId;
}
