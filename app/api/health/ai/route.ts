import { NextResponse } from "next/server";
import { getUsage } from "@/lib/ai/models";

/**
 * Diagnostic endpoint for the model picker. Returns per-model RPD usage
 * for the current UTC day, plus the time the counter will reset.
 *
 * Used by `evals/run.ts` to print a preflight table so we can see
 * which models have headroom before kicking off the suite.
 */
export async function GET() {
  return NextResponse.json({ usage: getUsage() });
}
