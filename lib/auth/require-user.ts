import { auth } from "@clerk/nextjs/server";

/**
 * Get the current Clerk user id from the request, or throw a 401.
 *
 * Use this at the top of every API route that needs an authenticated
 * user. Throwing keeps the route handler short — Next will turn the
 * thrown `Response` into the actual HTTP response.
 */
export async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return userId;
}
