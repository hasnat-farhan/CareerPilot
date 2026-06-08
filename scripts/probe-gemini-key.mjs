// One-shot probe: does the current GEMINI_API_KEY actually authenticate
// against the @google/generative-ai SDK right now? We don't need to
// hit our app — just call embedContent with a single short string.
//
// This is what /api/cv/upload does on the Vercel side too, so the
// answer is the same locally and on Vercel. If it fails here, the
// deploy will fail the same way.
//
// Run with: node scripts/probe-gemini-key.mjs

import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const key = process.env.GEMINI_API_KEY ?? process.env.Gemini_API_Key;
if (!key) {
  console.error("[probe] GEMINI_API_KEY is not set");
  process.exit(2);
}
console.log(
  `[probe] key prefix: ${key.slice(0, 4)}... (length=${key.length})`,
);

const model = process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001";
const client = new GoogleGenerativeAI(key);
const gen = client.getGenerativeModel({ model });

try {
  const r = await gen.embedContent({
    content: { role: "user", parts: [{ text: "hello world" }] },
  });
  const v = r.embedding?.values;
  if (!v || v.length === 0) {
    console.error("[probe] FAIL: empty embedding values");
    process.exit(1);
  }
  console.log(
    `[probe] OK: got ${v.length}-dim vector, first 4 = [${v.slice(0, 4).map((n) => n.toFixed(4)).join(", ")}]`,
  );
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[probe] FAIL: ${msg}`);
  process.exit(1);
}
