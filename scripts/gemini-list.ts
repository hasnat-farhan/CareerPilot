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

async function main() {
  for (const ver of ["v1beta", "v1"]) {
    const u = `https://generativelanguage.googleapis.com/${ver}/models?key=${k}`;
    const r = await fetch(u);
    const j: any = await r.json();
    const names: string[] = (j.models ?? []).map((m: any) => m.name).sort();
    console.log(`--- ${ver} count=${names.length} status=${r.status}`);
    for (const n of names) console.log("  ", n.replace(/^models\//, ""));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
