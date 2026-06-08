# CareerPilot — Evaluation Suite

The golden-case suite that verifies CareerPilot's four pillars end-to-end against the live API.
Each case is a small script under `evals/cases.json` that drives the running dev server with HTTP
requests and asserts on the response (status, body shape, latency, business logic).

The latest run wrote [`evals/results.md`](./results.md): **14 / 14 cases, weighted score 84.7 %, PASS**.

---

## Quickstart

```bash
# Terminal 1 — start the dev server in eval-bypass mode
#   (this sets EVAL_BYPASS_AUTH=1 so the suite can hit /api/* without a Clerk session,
#    and seeds a demo CV into Supabase)
npm run dev:eval

# Terminal 2 — run the suite (auto-detects the eval user from the seed step)
npm run evals
# → evals/results.md is rewritten with PASS/FAIL + per-case timings
```

`npm run evals` is wired to `tsx evals/run.ts`. The runner:
1. Calls `GET /api/health/ai` and prints a pre-flight table of the Gemini RPD budget.
2. Walks every case in `evals/cases.json` in order, prints `[i/14] case → …` per step.
3. Writes a Markdown report to `evals/results.md`.
4. Exits non-zero if the weighted score is below the **70 %** threshold.

To re-seed a fresh demo CV (idempotent, deletes the previous one first):

```bash
npx tsx scripts/seed-eval-cv.ts
```

---

## Testcases

The suite has **14 cases** across the four pillars. Each case is identified by a stable
`<surface>.<name>` key (e.g. `assistant.gap`). Surface names match the corresponding
`/api/*` namespace.

### Pillar 1 — Job Hunter Agent (`surface: hunter`)

| Case | What it asserts | Hard assertions |
|---|---|---|
| `hunter.basic` | Fan-out returns a deduped, ranked list of `JobCard`s. | HTTP 200, `>= 3` and `<= 10` cards, every card has `[title, company, url, source]`, unique on `[title, company]`. |

### Pillar 2 — Fit-score (`surface: fit-score`)

Both cases assert the breakdown keys `[skillOverlap, semantic, experience]` and that the score
falls into the expected band for a CV-tuned vs. a deliberately-mismatched JD.

| Case | JD vs. user's CV | Hard assertions | Notes |
|---|---|---|---|
| `fit_score.strong_match` | CV-tuned, must land in **[70, 100]** | `score in [70, 100]`, `breakdown` keys present | Tuned to the demo CV in `evals/demo_cvs/`. |
| `fit_score.weak_match` | Deliberately mismatched, must land in **[0, 40]** | `score in [0, 40]`, `breakdown` keys present | A deliberately bad CV/JD pairing. |

> **Why not LLM-only?** `lib/agents/fitScore.ts` returns a programmatic
> `0.60 × skill_overlap + 0.30 × semantic_similarity + 0.10 × experience_edu_match`. The LLM is
> only used to normalise skills; the formula itself is auditable and deterministic.

### Pillar 3 — Personal AI Assistant / RAG (`surface: chat`)

All chat cases hit `POST /api/chat/threads/[id]/messages`. The 5-intent router in
`lib/agents/assistant.ts` classifies the user message into one of
`readiness | gap | roadmap | cover_letter | general`; every non-general response cites the
CV chunks it used.

| Case | Mode expected | Asserts | Why it matters |
|---|---|---|---|
| `assistant.readiness` | `readiness` | reply contains "ready/gap/strong/senior/verdict/headline/next action"; `>= 1` citation | The headline verdict the user sees first on the dashboard. |
| `assistant.gap` | `gap` | reply contains "improve/learn/build/missing/strength"; structured `{ gaps: [...] }` shape | The skill-gap card on the Assistant page. |
| `assistant.roadmap` | `roadmap` | reply contains "phase/week/month"; structured `{ phases: [...] }` shape | Drives the 6-week roadmap UI. |
| `assistant.cover_letter` | `cover_letter` | `>= 250` chars, letter-shaped open/close ("Dear …", "Sincerely", …), `>= 1` citation | Long-form, user-visible; Gemini Pro tier. |
| `assistant.conversational_memory` | `general` | 2-turn thread, reply contains both the name ("Sarah") and the count ("5") from the prior turn | Multi-turn memory. |
| `assistant.off_topic_deflection` | `general` | Reply steers back to career topics (contains "career/job/cv/…") | Safety — refuse to drift off-domain. |
| `assistant.cv_rag_citations` | `general` | Reply contains a real fact from the demo CV (e.g. "38 % LCP", "Acme 200 k MAU"); `>= 1` citation | RAG grounding end-to-end. |

### Pillar 4 — Productivity & Tracker (`surface: productivity`)

Drives the Kanban, to-dos, goals, and weekly-stats surfaces via the `/api/todos`,
`/api/goals`, `/api/tracker/applications`, and `/api/productivity/stats` routes.

| Case | Steps | Asserts | Why it matters |
|---|---|---|---|
| `productivity.todo_lifecycle` | 4 | POST `/api/todos` → 200 with `{ todo }`; GET list contains it; PATCH `/{id}/done` flips `done=true`; re-GET shows `done` field present | Full CRUD on daily to-dos. |
| `productivity.goal_create_and_track` | 2 | POST `/api/goals` → 200; GET `?active=1` returns the new goal with `completed=false` | SMART goals surface. |
| `productivity.kanban_flow` | 4 | POST application → 200; PATCH `applied → interviewing → offer`; GET `/{id}` returns updated status + `history.length >= 2` | Kanban board with history jsonb. |
| `productivity.streak_stats` | 1 | GET `/api/productivity/stats?week=2026-W23` → 200 with top-level `{ stats, streak, roadmapPct }` | Powers the dashboard. |

---

## Authoring a new case

Each case in `evals/cases.json` has the shape:

```jsonc
{
  "id": "surface.unique_name",
  "name": "Human-readable title",
  "surface": "chat" | "fit-score" | "hunter" | "productivity",
  "weight": 1,                          // multiplied into the weighted score
  "input": { /* case-specific */ },     // message text, JD, role, week, …
  "expect": {                           // assertions the runner evaluates
    "mode": "general",                  // (chat) router mode
    "replyContainsAny": ["..."],        // any-of / all-of substring match
    "replyContainsAll": ["..."],
    "citationsCount": { "min": 1 },
    "minReplyLength": 250,
    "structuredResultShape": {          // (chat) validated against the parsed JSON
      "type": "object",
      "requiredKeys": ["gaps"]
    }
  }
}
```

Steps for multi-step productivity cases use a flat `steps: [{ request, expect }]` array and
assertion keys like `step 1 POST /api/todos → status 200 == 200`. The runner reports each step
individually so a failure points to the exact line.

### Assertion keys

| Key | Surface | Meaning |
|---|---|---|
| `mode` | chat | Router must classify the user message into this mode. |
| `replyContainsAny` / `replyContainsAll` | chat | Substring match against the assistant's reply (case-insensitive). |
| `citationsCount.min` | chat | Minimum number of `citations[]` entries the response must carry. |
| `minReplyLength` | chat | Reply must be at least N characters (long-form cases). |
| `structuredResultShape.{type,requiredKeys}` | chat | The LLM-returned JSON (after the mode-specific parser) must have these top-level keys. |
| `steps[].request` | productivity | A `method + path + body` HTTP request relative to `BASE_URL`. |
| `steps[].expect.status` | productivity | Exact HTTP status code expected. |
| `steps[].expect.bodyShape` | productivity | Top-level keys the JSON body must contain. |
| `steps[].expect.bodyField` | productivity | `{ path, equals }` — e.g. `status == offer`. |

### Scoring

Every assertion is graded. The case score is the **fraction of assertions that pass**;
the overall weighted score is `Σ(case.score × weight) / Σ(weight)`. The threshold is
**70 %** for a PASS.

| Score | Meaning |
|---|---|
| 1.00 | All assertions pass |
| 0.75 | All hard assertions pass; one soft assertion fails |
| 0.50 | Two assertions fail; case is salvageable |
| 0.25 | Most assertions fail; case is broken |

### Soft vs. hard assertions

- **Hard**: `mode`, `status`, body shape, `replyContainsAll`, `minReplyLength`, `citationsCount.min`. Failing any of these means the feature is broken.
- **Soft**: `replyContainsAny`, the optional structured-shape check on `assistant.gap` / `assistant.roadmap` when Gemini returns prose instead of strict JSON. A single soft miss drops the case to 0.75 but does not block the run.

Some cases (`assistant.readiness`, `assistant.gap`, `assistant.cover_letter`, `fit_score.weak_match`)
carry a small weight in `evals/cases.json` because the LLM-judge is the only thing we can
assert against in those scenarios — we do not want a flaky Gemini response to tank the
overall score.

---

## Layout

```
evals/
├── README.md          ← this file
├── cases.json         ← 14 golden cases
├── run.ts             ← runner (ts-node), writes evals/results.md
├── results.md         ← latest run (overwritten on each `npm run evals`)
└── demo_cvs/          ← seed CVs used by the fit-score and RAG cases
```

## See also

- [`docs/SYSTEM_DESIGN.md`](../docs/SYSTEM_DESIGN.md) — data model + RAG architecture
- Top-level [`README.md`](../README.md) — eval section + pillars tour
