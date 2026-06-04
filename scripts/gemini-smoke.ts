/**
 * One-off smoke test for the Gemini provider. Run with:
 *   npx tsx scripts/gemini-smoke.ts
 * (not used at runtime, no app imports it).
 */
import { readFileSync } from "node:fs";
import { embedText, chatComplete, AI_CONFIG } from "../lib/ai/provider";

// Minimal .env.local loader so this script works without `tsx --env-file`.
try {
  const txt = readFileSync(".env.local", "utf8");
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
} catch (e) {
  console.warn("could not read .env.local:", (e as Error).message);
}

async function main() {
  console.log("models:", AI_CONFIG);

  const vec = await embedText("CareerPilot puts your job search on autopilot.");
  console.log("embedding length:", vec.length, "first 4:", vec.slice(0, 4));

  const reply = await chatComplete(
    [{ role: "user", parts: "Reply with exactly: GEMINI_OK" }],
    { generationConfig: { temperature: 0, maxOutputTokens: 32 } },
  );
  console.log("chat reply:", JSON.stringify(reply));
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
