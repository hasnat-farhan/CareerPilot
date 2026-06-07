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
 *   EVAL_USER_ID=user_eval_demo \
 *   npx tsx evals/run.ts
 *
 * Auth:
 *   The runner needs the dev server started with EVAL_BYPASS_AUTH=1
 *   (`npm run dev:eval`). In that mode, the server honours an `x-eval-user-id`
 *   header in place of the Clerk session.
 *
 * Behaviour:
 *   - Each case is graded 0.0 / 0.25 / 0.5 / 0.75 / 1.0 per the rubric.
 *   - Final score = weighted mean of case scores.
 *   - The runner never throws on a failing case — it logs and moves on.
 *   - 5s pacing between cases to keep us under the 20 RPD daily caps on the
 *     Gemini flash models.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------- types -----------------------------------------------------------

type Surface = "chat" | "fit-score" | "hunter" | "productivity" | "cv";

type Expect =
  | {
      mode?: string;
      replyContainsAny?: string[];
      replyContainsAll?: string[];
      citationsCount?: { min: number };
      minReplyLength?: number;
      structuredResultShape?: { type: string; requiredKeys?: string[] } | null;
    }
  | {
      scoreRange?: { min: number; max: number };
      breakdownShape?: { type: string; requiredKeys?: string[] };
      weightsSumTo?: number;
    }
  | {
      minResults?: number;
      maxResults?: number;
      everyCardHas?: string[];
      uniqueBy?: string[];
    }
  | {
      allStepsPass?: boolean;
      // The productivity surface also returns the per-step results inline.
    }
  | Record<string, unknown>;

type Case = {
  id: string;
  name: string;
  surface: Surface;
  weight?: number;
  input: Record<string, unknown>;
  expect: Expect;
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

const casesPath = resolve(process.cwd(), "evals", "cases.json");
const resultsPath = resolve(process.cwd(), "evals", "results.md");

function loadCases(): { cases: Case[]; fixtures: Record<string, string> } {
  const raw = readFileSync(casesPath, "utf-8");
  const parsed: CasesFile = JSON.parse(raw);
  // inline fixture interpolation: "<REPLACE_WITH_FIXTURE.sampleJdText>".
  // We are substituting INTO a JSON-encoded string, so the replacement value
  // must itself be JSON-escaped — otherwise real newlines in the fixture land
  // inside a JSON string literal and JSON.parse rejects them.  `replacer`
  // receives the encoded token (a JSON string) and returns the encoded form
  // of the fixture so the surrounding `JSON.stringify` round-trip stays valid.
  const fixtures = parsed.fixtures ?? {};
  const interpolated = JSON.parse(
    JSON.stringify(parsed).replace(
      /"<REPLACE_WITH_FIXTURE\.([a-zA-Z0-9_]+)>"/g,
      (_, key) => (key in fixtures ? JSON.stringify(fixtures[key]) : '""'),
    ),
  );
  return { cases: interpolated.cases, fixtures };
}

// ---------- http helper -----------------------------------------------------

const BASE_URL = process.env.EVAL_BASE_URL ?? "http://localhost:3000";

// See lib/auth/require-user.ts: when EVAL_BYPASS_AUTH=1, the server honours
// this header in place of the Clerk session.
const EVAL_USER_ID = process.env.EVAL_USER_ID ?? "user_eval_demo";

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T | null; text: string }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-eval-user-id": EVAL_USER_ID,
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
  return { status: res.status, data, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- surface runners -------------------------------------------------

async function runChat(c: Case): Promise<CaseResult> {
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
    const title = (c.input.threadTitle as string) ?? "Eval thread";
    const created = await api<{ thread?: { id: string } }>("POST", "/api/chat/threads", { title });
    const threadId = created.data?.thread?.id;
    if (created.status !== 200 || !threadId) {
      return {
        id: c.id, name: c.name, surface: c.surface, score: 0, passed: false,
        durationMs: Date.now() - t0, details,
        error: `thread create failed: ${created.status} ${JSON.stringify(created.data)}`,
      };
    }
    details.push(`thread=${threadId}`);

    const messages = (c.input.messages as Array<{ role: string; content: string }>) ?? [];
    let lastReply: any = null;
    let lastMode: string | undefined;
    let lastCitations: any[] = [];
    let lastStructured: any = null;
    for (const m of messages) {
      const r = await api<any>("POST", `/api/chat/threads/${threadId}/messages`, { content: m.content });
      if (r.status !== 200 || !r.data) {
        return {
          id: c.id, name: c.name, surface: c.surface, score: 0, passed: false,
          durationMs: Date.now() - t0, details,
          error: `message POST failed: ${r.status} ${r.data ? JSON.stringify(r.data).slice(0, 200) : ""}`,
        };
      }
      lastReply = r.data;
      lastMode = r.data.mode;
      lastCitations = r.data.citations ?? [];
      lastStructured = r.data.structured ?? r.data.structuredResult ?? null;
    }
    const replyText: string = String(lastReply?.message?.content ?? "").toLowerCase();
    details.push(`mode=${lastMode ?? "?"}`);
    details.push(`reply.length=${replyText.length}`);
    details.push(`citations=${lastCitations.length}`);
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
    return { id: c.id, name: c.name, surface: c.surface, score, passed: score >= 0.75, durationMs: Date.now() - t0, details };
  } catch (err) {
    return {
      id: c.id, name: c.name, surface: c.surface, score: 0, passed: false,
      durationMs: Date.now() - t0, details, error: String(err),
    };
  }
}

async function runFitScore(c: Case): Promise<CaseResult> {
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
      return { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: `fit-score failed: ${r.status}` };
    }
    const fs = r.data.result ?? r.data;
    details.push(`score=${fs.score}`);
    const checks: { ok: boolean; why: string }[] = [];
    if (expect.scoreRange) {
      checks.push({ ok: fs.score >= expect.scoreRange.min && fs.score <= expect.scoreRange.max, why: `score in [${expect.scoreRange.min}, ${expect.scoreRange.max}]` });
    }
    if (expect.breakdownShape?.requiredKeys) {
      const keys = Object.keys(fs.breakdown ?? {});
      const missing = expect.breakdownShape.requiredKeys.filter((k) => !keys.includes(k));
      checks.push({ ok: missing.length === 0, why: `breakdown keys: [${expect.breakdownShape.requiredKeys.join(", ")}]` });
    }
    if (typeof expect.weightsSumTo === "number" && fs.breakdown) {
      const sum = (fs.breakdown.skillOverlap ?? 0) + (fs.breakdown.semantic ?? 0) + (fs.breakdown.experience ?? 0);
      checks.push({ ok: Math.abs(sum - expect.weightsSumTo) < 0.01, why: `weights sum to ${sum.toFixed(3)}` });
    }
    const hardFails = checks.filter((x) => !x.ok).length;
    const score = checks.length === 0 ? 0 : hardFails === 0 ? 1.0 : hardFails === 1 ? 0.5 : 0.25;
    details.push(...checks.map((x) => `  ${x.ok ? "✓" : "✗"} ${x.why}`));
    return { id: c.id, name: c.name, surface: c.surface, score, passed: score >= 0.75, durationMs: Date.now() - t0, details };
  } catch (err) {
    return { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: String(err) };
  }
}

async function runHunter(c: Case): Promise<CaseResult> {
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
      return { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: `hunt failed: ${r.status}` };
    }
    const cards: any[] = r.data.results ?? r.data.cards ?? r.data.jobs ?? [];
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
    return { id: c.id, name: c.name, surface: c.surface, score, passed: score >= 0.75, durationMs: Date.now() - t0, details };
  } catch (err) {
    return { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: String(err) };
  }
}

// ---------- productivity surface -------------------------------------------

type StepExpect = {
  status?: number;
  shape?: { requiredKeys?: string[] };
  listKey?: string;
  minLen?: number;
  everyItemHas?: string[];
  everyItem?: Record<string, unknown>;
  statusField?: string;
  historyLenAtLeast?: number;
};

type Step = { method: string; path: string; body?: unknown; expect?: StepExpect };

/**
 * Resolves `__ID__` placeholders in a path by scanning the latest response
 * body for an id-like field. Heuristic: try `id`, `todo.id`, `goal.id`,
 * `application.id` in that order.
 */
function pickIdFromResponse(data: any): string | null {
  if (!data) return null;
  if (typeof data.id === "string") return data.id;
  for (const wrapper of ["todo", "goal", "application"]) {
    if (data[wrapper]?.id) return data[wrapper].id;
  }
  return null;
}

async function runProductivity(c: Case): Promise<CaseResult> {
  const t0 = Date.now();
  const details: string[] = [];
  try {
    const steps = (c.input.steps as Step[]) ?? [];
    if (steps.length === 0) {
      return { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: "no steps in input" };
    }
    let lastId: string | null = null;
    const checks: { ok: boolean; why: string }[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const path = lastId ? step.path.replaceAll("__ID__", lastId) : step.path.replaceAll("__ID__", "");
      const r = await api<any>(step.method, path, step.body);
      const exp = step.expect ?? {};
      const checkLabel = `step ${i + 1} ${step.method} ${path}`;
      const ok = (cond: boolean, why: string) => {
        checks.push({ ok: cond, why: `${checkLabel} → ${why}` });
      };

      // 1. status
      if (typeof exp.status === "number") {
        ok(r.status === exp.status, `status ${r.status} == ${exp.status}`);
      }
      // 2. shape
      if (exp.shape?.requiredKeys) {
        const keys = Object.keys(r.data ?? {});
        const missing = exp.shape.requiredKeys.filter((k) => !keys.includes(k));
        ok(missing.length === 0, `top-level keys: [${exp.shape.requiredKeys.join(", ")}]`);
      }
      // 3. listKey + minLen
      if (exp.listKey) {
        const list = (r.data ?? {})[exp.listKey];
        const len = Array.isArray(list) ? list.length : 0;
        if (typeof exp.minLen === "number") {
          ok(len >= exp.minLen, `list.${exp.listKey}.length >= ${exp.minLen} (got ${len})`);
        }
        // 4. everyItemHas
        if (exp.everyItemHas && Array.isArray(list)) {
          const missing = list.filter((it: any) => exp.everyItemHas!.some((k) => !(k in it)));
          ok(missing.length === 0, `every item has [${exp.everyItemHas.join(", ")}]`);
        }
        // 5. everyItem (field equality)
        if (exp.everyItem && Array.isArray(list)) {
          for (const [k, v] of Object.entries(exp.everyItem)) {
            const bad = list.filter((it: any) => it[k] !== v);
            ok(bad.length === 0, `every item ${k} == ${JSON.stringify(v)}`);
          }
        }
      }
      // 6. statusField (on a single-entity response)
      if (exp.statusField && r.data) {
        // The route may return the row directly or wrapped in { application: ... }
        const entity = r.data.application ?? r.data.todo ?? r.data.goal ?? r.data;
        ok(entity?.status === exp.statusField, `status field == ${exp.statusField} (got ${entity?.status})`);
      }
      // 7. historyLenAtLeast
      if (typeof exp.historyLenAtLeast === "number" && r.data) {
        const app = r.data.application ?? r.data;
        const hist = Array.isArray(app?.history) ? app.history : [];
        ok(hist.length >= exp.historyLenAtLeast, `history length >= ${exp.historyLenAtLeast} (got ${hist.length})`);
      }
      // remember the id for the next step
      const newId = pickIdFromResponse(r.data);
      if (newId) lastId = newId;
    }
    const hardFails = checks.filter((x) => !x.ok).length;
    const score = checks.length === 0 ? 0
      : hardFails === 0 ? 1.0
      : hardFails === 1 ? 0.75
      : hardFails === 2 ? 0.5
      : 0.25;
    details.push(`steps=${steps.length}`);
    details.push(...checks.map((x) => `  ${x.ok ? "✓" : "✗"} ${x.why}`));
    return { id: c.id, name: c.name, surface: c.surface, score, passed: score >= 0.75, durationMs: Date.now() - t0, details };
  } catch (err) {
    return { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: String(err) };
  }
}

// ---------- cv surface (smoke) ---------------------------------------------

async function runCv(c: Case): Promise<CaseResult> {
  const t0 = Date.now();
  const details: string[] = [];
  try {
    // The CV surface is implicit: seed-eval-cv.ts must have been run before
    // the runner, and the `assistant.cv_rag_citations` chat case already
    // exercises the RAG path. Here we just verify the active CV row exists
    // for the eval user.
    const r = await api<any>("GET", "/api/cv/list");
    details.push(`status=${r.status}`);
    if (r.status !== 200 || !r.data) {
      return { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: `cv list failed: ${r.status}` };
    }
    const cvs: any[] = r.data.cvs ?? r.data.items ?? r.data ?? [];
    const active = cvs.filter((cv: any) => cv.is_active !== false);
    details.push(`cvs=${cvs.length} active=${active.length}`);
    const ok = active.length >= 1;
    details.push(`  ${ok ? "✓" : "✗"} at least 1 active CV row for ${EVAL_USER_ID}`);
    return { id: c.id, name: c.name, surface: c.surface, score: ok ? 1.0 : 0, passed: ok, durationMs: Date.now() - t0, details };
  } catch (err) {
    return { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: Date.now() - t0, details, error: String(err) };
  }
}

// ---------- main ------------------------------------------------------------

async function main() {
  const { cases } = loadCases();
  const start = Date.now();
  console.log(`▶ CareerPilot eval — ${cases.length} cases against ${BASE_URL}`);
  console.log(`▶ Eval user id: ${EVAL_USER_ID} (server must have EVAL_BYPASS_AUTH=1)`);

  // Preflight: print per-model RPD usage so we know which models still
  // have headroom before the suite starts. If everything is exhausted
  // we want a clear "wait until UTC midnight" message, not a silent
  // failure 60 s in.
  try {
    const healthRes = await fetch(`${BASE_URL}/api/health/ai`);
    if (healthRes.ok) {
      const health = (await healthRes.json()) as {
        usage: {
          model: string;
          tier: string;
          used: number;
          remaining: number;
          rpd: number;
        }[];
      };
      console.log(`▶ Model RPD usage (UTC day):`);
      for (const u of health.usage) {
        console.log(
          `   · ${u.model.padEnd(24)} ${u.tier.padEnd(8)} ` +
            `${u.used.toString().padStart(3)}/${u.rpd} used ` +
            `(${u.remaining} left)`,
        );
      }
    } else {
      console.log(
        `▶ (preflight skipped — /api/health/ai returned ${healthRes.status})`,
      );
    }
  } catch (e) {
    console.log(
      `▶ (preflight skipped — could not reach /api/health/ai: ${(e as Error).message})`,
    );
  }

  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`  · ${c.id} ... `);
    let result: CaseResult;
    if (c.surface === "chat") result = await runChat(c);
    else if (c.surface === "fit-score") result = await runFitScore(c);
    else if (c.surface === "hunter") result = await runHunter(c);
    else if (c.surface === "productivity") result = await runProductivity(c);
    else if (c.surface === "cv") result = await runCv(c);
    else {
      console.log(`unknown surface: ${c.surface}`);
      result = { id: c.id, name: c.name, surface: c.surface, score: 0, passed: false, durationMs: 0, details: [], error: `unknown surface: ${c.surface}` };
    }
    results.push(result);
    console.log(`${result.passed ? "PASS" : "FAIL"} (${result.score.toFixed(2)}) in ${result.durationMs}ms`);
    // Pacing: keep us under the 20 RPD daily caps on the Gemini flash models.
    // 5 s × 14 cases ≈ 70 s of wall time; one chat case may use 2-3 model
    // calls, so 5 s gives a comfortable margin.
    if (c !== cases[cases.length - 1]) await sleep(5000);
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
  lines.push(`- **Eval user:** \`${EVAL_USER_ID}\``);
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
