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

async function probe(model: string) {
  const u = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent?key=${k}`;
  const body = {
    content: { role: "user", parts: [{ text: "CareerPilot smoke test" }] },
  };
  const r = await fetch(u, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j: any = await r.json();
  const dim = j?.embedding?.values?.length ?? 0;
  console.log(`${model}: status=${r.status} dim=${dim}`);
  if (r.status !== 200) console.log("  err:", j?.error?.message ?? j);
}

async function probeChat(model: string) {
  const u = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${k}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: "Reply with exactly: GEMINI_OK" }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 16 },
  };
  const r = await fetch(u, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j: any = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  console.log(`${model}: status=${r.status} reply=${JSON.stringify(text)}`);
  if (r.status !== 200) console.log("  err:", j?.error?.message ?? j);
}

async function main() {
  for (const m of ["gemini-embedding-001", "gemini-embedding-2", "gemini-embedding-2-preview"]) {
    await probe(m);
  }
  for (const m of [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3.5-flash",
    "gemini-2.0-flash",
  ]) {
    await probeChat(m);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
