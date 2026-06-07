/**
 * CareerPilot evaluation runner.
 *
 * Reads `evals/cases.json`, hits the live Next.js dev server at $EVAL_BASE_URL
 * (default http://localhost:3000), and writes a Markdown verdict table to
 * `evals/results.md`. Designed for the Codesprint Poridhi demo.
 *
 * Usage:
 *   # In one terminal:
 *   npm run dev
 *   # In another:
 *   EVAL_BASE_URL=http://localhost:3000 \
 *   EVAL_AUTH_TOKEN="<clerk session jwt>" \
 *   npx tsx evals/run.ts
 *
 * Auth:
 *   The runner needs a Clerk session JWT for the /api/* routes. The easiest
 *   way is to:
 *     1. Sign in to the dashboard in a browser.
 *     2. Open DevTools → Application → Cookies → __session (or the Clerk
 *        session cookie), copy the value, and pass it as EVAL_AUTH_TOKEN.
 *   For headless CI, mint a session via Clerk's testing tokens.
 *
 * Behaviour:
 *   - Each case is graded 0.0 / 0.25 / 0.5 / 0.75 / 1.0 per the rubric.
 *   - Final score = weighted mean of case scores.
 *   - The runner never throws on a failing case — it logs and moves on.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------- types -----------------------------------------------------------

type Case = {
  id: string;
  name: string;
  surface: "chat" | "fit-score" | "hunter";
  weight?: number;
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
};

type CasesFile = {
  version: string;
  description: string;
  fixtures?: Record<string, string>;
  cases: Case[];
};

type CaseResult = {
  id: string;
  name: string;
  surface: string;
  score: number;
  passed: boolean;
  durationMs: number;
  details: string[];
  error?: string;
};

// ---------- io --------------------------------------------------------------

// Resolve paths relative to the current working directory. The runner is
// invoked via `npx tsx evals/run.ts` from the project root, so CWD == the
// directory containing `evals/`.
const casesPath = resolve(process.cwd(), "evals", "cases.json");
const resultsPath = resolve(process.cwd(), "evals", "results.md");
const fixtures: Record<string, string> = {};

function loadCases(): { cases: Case[]; fixtures: Record<string, string> } {
  const raw = readFileSync(casesPath, "utf-8");
  const parsed: CasesFile = JSON.parse(raw);
  // inline fixture interpolation: "<REPLACE_WITH_FIXTURE.sampleJdText>"
  const interpolated = JSON.parse(
    JSON.stringify(parsed).replace(
      /<REPLACE_WITH_FIXTURE\.([a-zA-Z0-9_]+)>/g,
      (_, key) => parsed.fixtures?.[key] ?? "",
    ),
  );
  return { cases: interpolated.cases, fixtures: parsed.fixtures ?? {} };
}

// ---------- http helper -----------------------------------------------------

const BASE_URL = process.env.EVAL_BASE_URL ?? "http://localhost:3000";
let AUTH_TOKEN = process.env.EVAL_AUTH_TOKEN ?? "";

// ---------- auth resolver ---------------------------------------------------
//
// Resolution order:
//   1. EVAL_AUTH_TOKEN env var (non-interactive).
//   2. Interactive prompt — paste the Clerk `__session` JWT from your browser.
//
// To get a __session JWT:
//   a. Browser: sign in to http://localhost:3000/dashboard, then DevTools →
//      Application → Cookies → `__session` → copy Value.
//   b. Headless (requires network + Clerk CLI): `clerk testing-tokens create
//      --user user_xxx --json | jq -r .jwt`.
async function resolveAuthToken(): Promise<string> {
  if (AUTH_TOKEN) return AUTH_TOKEN;
  if (!process.stdin.isTTY) {
    throw new Error(
      "No EVAL_AUTH_TOKEN and no TTY to prompt. Set EVAL_AUTH_TOKEN=<clerk __session JWT> and re-run.",
    );
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const token = (await rl.question("Clerk __session JWT (paste from DevTools → Cookies): ")).trim();
    if (!token) throw new Error("Empty session token — aborting.");
    return token;
  } finally {
    rl.close();
  }
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T | null }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN ? { Cookie: `__session=${AUTH_TOKEN}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

// ---------- surface runners -------------------------------------------------

async function runChat(c: Case): Promise<{ result: CaseResult; reply?: any; mode?: string; citations?: any[]; structured?: any }> {
  const t0 = Date.now();
  const details: string[] = [];
  const expect = c.expect as {
    mode?: string;
    replyContainsAny?: string[];
    replyContainsAll?: string[];
    citationsCount?: { min: number };
    minReplyLength?: number;
    structuredResultShape?: { type: string; requiredKeys?: string[] } | null;
  };

  try {
    // 1. create thread
    const title = (c.input.threadTitle as string) ?? "Eval thread";
    const created = await api<{ id: string }>("POST", "/api/chat/threads", { title });
    if (created.status !== 200 || !created.data?.id) {
      return {
        result: {
          id: c.id, name: c.name, surface: c.surface, score: 0, passed: false,
          durationMs: Date.now() - t0, details,
          error: `thread create failed: ${created.status} ${JSON.stringify(created.data)}`,
        },
      };
    }
    const threadId = created.data.id;
    details.push(`thread=${threadId}`);

    // 2. send each user message, collect replies
    const messages = (c.input.messages as Array<{ role: string; content: string }>) ?? [];
    let lastReply: any = null;
    let lastMode: string | undefined;
    let lastCitations: any[] = [];
    let lastStructured: any = null;
    for (const m of messages) {
      const r = await api<any>("POST", `/api/chat/threads/${threadId}/messages`, { content: m.content });
      if (r.status !== 200 || !r.data) {
        return {
          result: {
            id: c.id, name: c.name, surface: c.surface, score: 0, passed: false,
            durationMs: Date.now() - t0, details,
            error: `message POST failed: ${r.status}`,
          },
        };
      }
      lastReply = r.data;
      lastMode = r.data.mode;
      lastCitations = r.data.citations ?? [];
      lastStructured = r.data.structuredResult;
    }
    details.push(`mode=${lastMode ?? "?"}`);
    details.push(`reply.length=${String(lastReply?.reply ?? "").length}`);
    details.push(`citations=${lastCitations.length}`);

    // 3. assertions
    const replyText: string = String(lastReply?.reply ?? "").toLowerCase();
    const checks: { ok: boolean; why: string }[] = [];

    if (expect.mode) {
      checks.push({ ok: lastMode === expect.mode, why: `mode == ${expect.mode}` });
    }
    if (expect.replyContainsAny) {
      const hit = expect.replyContainsAny.some((s) => replyText.includes(s.toLowerCase()));
      checks.push({ ok: hit, why: `reply contains any of [${expect.replyContainsAny.join(", ")}]` });
    }
    if (expect.replyContainsAll) {
      const hit = expect.replyContainsAll.every((s) => replyText.includes(s.toLowerCase()));
      checks.push({ ok: hit, why: `reply contains all of [${expect.replyContainsAll.join(", ")}]` });
    }
    if (expect.citationsCount) {
      checks.push({ ok: lastCitations.length >= expect.citationsCount.min, why: `citations >= ${expect.citationsCount.min}` });
    }
    if (expect.minReplyLength) {
      checks.push({ ok: replyText.length >= expect.minReplyLength, why: `reply length >= ${expect.minReplyLength}` });
    }
    if (expect.structuredResultShape?.requiredKeys) {
      const keys = Object.keys(lastStructured ?? {});
      const missing = expect.structuredResultShape.requiredKeys.filter((k) => !keys.includes(k));
      checks.push({ ok: missing.length === 0, why: `structured keys: [${expect.structuredResultShape.requiredKeys.join(", ")}]` });
    }

    const hardFails = checks.filter((x) => !x.ok).length;
    const score = checks.length === 0 ? 0
      : hardFails === 0 ? 1.0
      : hardFails === 1 ? 0.75
      : hardFails === 2 ? 0.5
      : 0.25;
    details.push(...checks.map((x) => `  ${x.ok ? "✓" : "✗"} ${x.why}`));
    return {
      result: { id: c.id, name: c.name, surface: c.surface, score, passed: score >= 0.75, durationMs: Date.now() - t0, details },
      reply: lastReply, mode: lastMode, citations: lastCitations, structured: lastStructured,
    };
  } catch (err) {
    return {
      result: {
        id: c.id, name: c.name, surface: c.surface, score: 0, passed: false,
        durationMs: Date.now() - t0, details, error: String(err),
      },
    };
  }
}

async function runFitScore(c: Case): Promise<{ result: CaseResult; payload?: any }> {
  const t0 = Date.now();
  const details: string[] = [];
  const expect = c.expect as {
    scoreRange?: { min: number; max: number };
    breakdownShape?: { type: string; requiredKeys?: string[] };
    weightsSumTo?: number;
  };
  try {
    const r = await api<any>("POST", "/api/fit-score", c.input);
    details.push(`status=${r.status}`);
    if (r.status !== 200 || !r.data) {
      return { result: { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: `fit-score failed: ${r.status}` } };
    }
    details.push(`score=${r.data.score}`);
    const checks: { ok: boolean; why: string }[] = [];
    if (expect.scoreRange) {
      checks.push({ ok: r.data.score >= expect.scoreRange.min && r.data.score <= expect.scoreRange.max, why: `score in [${expect.scoreRange.min}, ${expect.scoreRange.max}]` });
    }
    if (expect.breakdownShape?.requiredKeys) {
      const keys = Object.keys(r.data.breakdown ?? {});
      const missing = expect.breakdownShape.requiredKeys.filter((k) => !keys.includes(k));
      checks.push({ ok: missing.length === 0, why: `breakdown keys: [${expect.breakdownShape.requiredKeys.join(", ")}]` });
    }
    if (typeof expect.weightsSumTo === "number" && r.data.breakdown) {
      const sum = (r.data.breakdown.skills ?? 0) + (r.data.breakdown.semantic ?? 0) + (r.data.breakdown.experience_edu ?? 0);
      checks.push({ ok: Math.abs(sum - expect.weightsSumTo) < 0.01, why: `weights sum to ${sum.toFixed(3)}` });
    }
    const hardFails = checks.filter((x) => !x.ok).length;
    const score = checks.length === 0 ? 0 : hardFails === 0 ? 1.0 : hardFails === 1 ? 0.5 : 0.25;
    details.push(...checks.map((x) => `  ${x.ok ? "✓" : "✗"} ${x.why}`));
    return { result: { id: c.id, name: c.name, surface: c.surface, score, passed: score >= 0.75, durationMs: Date.now() - t0, details }, payload: r.data };
  } catch (err) {
    return { result: { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: String(err) } };
  }
}

async function runHunter(c: Case): Promise<{ result: CaseResult; cards?: any[] }> {
  const t0 = Date.now();
  const details: string[] = [];
  const expect = c.expect as {
    minResults?: number; maxResults?: number;
    everyCardHas?: string[];
    uniqueBy?: string[];
  };
  try {
    const r = await api<any>("POST", "/api/hunt", c.input);
    details.push(`status=${r.status}`);
    if (r.status !== 200 || !r.data) {
      return { result: { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: `hunt failed: ${r.status}` } };
    }
    const cards: any[] = r.data.results ?? r.data.cards ?? r.data ?? [];
    details.push(`cards=${cards.length}`);
    const checks: { ok: boolean; why: string }[] = [];
    if (typeof expect.minResults === "number") {
      checks.push({ ok: cards.length >= expect.minResults, why: `>= ${expect.minResults} results` });
    }
    if (typeof expect.maxResults === "number") {
      checks.push({ ok: cards.length <= expect.maxResults, why: `<= ${expect.maxResults} results` });
    }
    if (expect.everyCardHas) {
      const missing = cards.filter((card: any) => expect.everyCardHas!.some((k) => !card[k]));
      checks.push({ ok: missing.length === 0, why: `every card has [${expect.everyCardHas.join(", ")}]` });
    }
    if (expect.uniqueBy) {
      const seen = new Set<string>();
      let dupes = 0;
      for (const card of cards) {
        const k = expect.uniqueBy.map((f) => String(card[f] ?? "").toLowerCase()).join("|");
        if (seen.has(k)) dupes++;
        seen.add(k);
      }
      checks.push({ ok: dupes === 0, why: `unique by [${expect.uniqueBy.join(", ")}]` });
    }
    const hardFails = checks.filter((x) => !x.ok).length;
    const score = checks.length === 0 ? 0 : hardFails === 0 ? 1.0 : hardFails === 1 ? 0.5 : 0.25;
    details.push(...checks.map((x) => `  ${x.ok ? "✓" : "✗"} ${x.why}`));
    return { result: { id: c.id, name: c.name, surface: c.surface, score, passed: score >= 0.75, durationMs: Date.now() - t0, details }, cards };
  } catch (err) {
    return { result: { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: String(err) } };
  }
}

// ---------- main ------------------------------------------------------------

async function main() {
  AUTH_TOKEN = await resolveAuthToken();
  const { cases, fixtures: fx } = loadCases();
  const start = Date.now();
  console.log(`▶ CareerPilot eval — ${cases.length} cases against ${BASE_URL}`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`  · ${c.id} ... `);
    let out: { result: CaseResult };
    if (c.surface === "chat") out = await runChat(c);
    else if (c.surface === "fit-score") out = await runFitScore(c);
    else if (c.surface === "hunter") out = await runHunter(c);
    else { console.log("unknown surface"); continue; }
    results.push(out.result);
    console.log(`${out.result.passed ? "PASS" : "FAIL"} (${out.result.score.toFixed(2)}) in ${out.result.durationMs}ms`);
  }

  const totalWeight = cases.reduce((s, c) => s + (c.weight ?? 1), 0);
  const weighted = results.reduce((s, r) => {
    const w = cases.find((c) => c.id === r.id)?.weight ?? 1;
    return s + r.score * w;
  }, 0) / totalWeight;

  const md = renderMarkdown(results, weighted, totalWeight, start);
  writeFileSync(resultsPath, md, "utf-8");
  console.log(`\n▶ Weighted score: ${(weighted * 100).toFixed(1)}%`);
  console.log(`▶ Verdict table written to evals/results.md`);
  process.exit(weighted >= 0.7 ? 0 : 1);
}

function renderMarkdown(results: CaseResult[], weighted: number, totalWeight: number, start: number): string {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`# CareerPilot — Evaluation Results`);
  lines.push(``);
  lines.push(`- **Run at:** ${ts}`);
  lines.push(`- **Base URL:** \`${BASE_URL}\``);
  lines.push(`- **Cases:** ${results.length}`);
  lines.push(`- **Weighted score:** **${(weighted * 100).toFixed(1)}%**`);
  lines.push(`- **Verdict:** ${weighted >= 0.7 ? "✅ PASS" : "❌ FAIL"} (threshold 70%)`);
  lines.push(`- **Duration:** ${((Date.now() - start) / 1000).toFixed(1)} s`);
  lines.push(``);
  lines.push(`| # | Case | Surface | Score | Pass | Duration |`);
  lines.push(`|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | \`${r.id}\` | ${r.surface} | ${(r.score * 100).toFixed(0)}% | ${r.passed ? "✅" : "❌"} | ${r.durationMs} ms |`);
  });
  lines.push(``);
  lines.push(`## Detail`);
  lines.push(``);
  for (const r of results) {
    lines.push(`### ${r.passed ? "✅" : "❌"} ${r.id} — ${r.name}`);
    lines.push(``);
    if (r.error) lines.push(`> **Error:** ${r.error}`);
    for (const d of r.details) lines.push(`- ${d}`);
    lines.push(``);
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
