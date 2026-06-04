import { readFileSync } from "node:fs";

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
} catch {}

const k = process.env.GEMINI_API_KEY!;

async function chat(model: string, maxOut: number) {
  const u = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${k}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: "Reply with exactly: GEMINI_OK" }] }],
    generationConfig: { temperature: 0, maxOutputTokens: maxOut },
  };
  const r = await fetch(u, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j: any = await r.json();
  const cand = j?.candidates?.[0];
  const text = cand?.content?.parts?.[0]?.text ?? "";
  const reason = cand?.finishReason ?? "";
  const safety = j?.promptFeedback?.blockReason ?? "";
  console.log(`${model} (maxOut=${maxOut}): status=${r.status} finishReason=${reason} blockReason=${safety} text=${JSON.stringify(text)}`);
  if (r.status !== 200) console.log("  err:", j?.error?.message ?? j);
}

async function main() {
  await chat("gemini-3.5-flash", 16);
  await chat("gemini-3.5-flash", 256);
  await chat("gemini-3.5-flash", 2048);
  await chat("gemini-2.5-flash", 256);
  await chat("gemini-flash-latest", 256);
}

main().catch((e) => { console.error(e); process.exit(1); });
