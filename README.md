<div align="center">

# CareerPilot

**An agentic career co-pilot that turns your CV into a living, search-and-apply job search engine.**

Built for the Codesprint Poridhi hackathon (June 2026).
Category: Agentic / AI · Theme: Career acceleration

</div>

---

## The problem

Job search is broken. A candidate uploads a CV once, then answers the same twelve questions on every portal. Career tools don't share memory, don't model the user's actual skill graph, and don't get smarter as you apply.

## What CareerPilot does

One upload, one brain, four agents working in concert:

| # | Pillar | What it does |
|---|---|---|
| 1 | **Job Hunter Agent** | Given your CV + a target role, fans out across 4 live job boards (Adzuna, Arbeitnow, RemoteOK, The Muse) plus Tavily web search (called inline from `lib/agents/hunter.ts`), dedupes, ranks by fit, and returns the top 10 in seconds. |
| 2 | **CV / Profile Intelligence (RAG)** | Parses your PDF or DOCX, chunks it semantically, embeds it with Gemini Embedding 2, and stores vectors in Supabase pgvector. Every downstream query is grounded in *your* CV, not generic LLM priors. |
| 3 | **Personal AI Assistant** | A 5-intent router (`readiness` / `gap` / `roadmap` / `cover_letter` / `general`) that always cites the chunks it used, maintains full conversational memory, and persists each exchange to `chat_messages`. |
| 4 | **Productivity & Progress Tracker** | Drag-and-drop Kanban (Applied → Interviewing → Offer → Rejected), a calendar with daily to-dos and goal deadlines, a streak counter, and a weekly stats view rendered from a single SQL view (`v_weekly_stats`). |

The RAG layer is the single source of truth: the assistant cites chunks, the fit-score reasons over the same vectors, and the hunter prompt is grounded in your real skills.

---

## Live demo

> 🚧 Pending deploy — see [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) § *Deployment* for the architecture and the Netlify plan.

---

## Architecture at a glance

```
              ┌────────────────────────────────────────────────────────┐
              │                    Browser (Next 15 / RSC)              │
              └────────────┬───────────────────────────────────────────┘
                           │  Clerk session
                           ▼
   ┌───────────── Next.js 15 App Router (Vercel/Netlify) ─────────────┐
   │                                                                   │
   │   app/(dashboard)  ──  cv  ──  hunter  ──  chat  ──  fit-score    │
   │                              │       │          │                 │
   │                              ▼       ▼          ▼                 │
   │   app/api/*  ──►  lib/agents/*  ──►  lib/ai/provider.ts           │
   │                          │              │                         │
   │                          │              ▼                         │
   │                          │      Gemini 3 (Flash / Pro) +          │
   │                          │      Gemini Embedding 2 (3072-dim)     │
   │                          ▼                                       │
   │                   lib/supabase/admin.ts                           │
   └────────────┬─────────────────────────────────────────────────────┘
                │
                ▼
   ┌──────── Supabase (Postgres + pgvector + Storage) ───────────────┐
   │                                                                 │
   │   cvs · cv_chunks · hunter_runs · hunter_saved                  │
   │   fit_scores · chat_threads · chat_messages                     │
   │   applications · goals · todos · v_weekly_stats (view)          │
   └─────────────────────────────────────────────────────────────────┘
```

Full system design, data model, scale-out math, and failure modes: [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md).

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| **Framework** | Next.js 15.5 (App Router, RSC, Turbopack) | Single repo for UI + API, server actions cut latency, Netlify/Vercel deploy |
| **UI** | React 19, Tailwind CSS 3.4, lucide-react | Server components + a tight custom design system (`brand-dna.md`) |
| **Auth** | Clerk | Email + OAuth, session cookies for the Supabase server client |
| **Database** | Supabase Postgres + pgvector | One service for relational data, vectors, and file storage |
| **File storage** | Supabase Storage (`cvs` bucket) | PDFs/DOCX uploaded directly, signed-URL download |
| **LLM** | Gemini 3 Flash + Pro (rotated), Gemini Embedding 2 | 3072-dim embeddings, Flash for most calls, Pro for cover letters |
| **Job sources** | Adzuna · Arbeitnow · RemoteOK · The Muse · Tavily (web search) | 4 free / low-cost boards + 1 web search, all live, deduped on (title, company) |
| **Type safety** | TypeScript strict | All API routes typed end-to-end |
| **Hosting** | Netlify (Netlify Next.js plugin) | `@netlify/plugin-nextjs`; `/api/cv/upload` runs in 26 s (sync parse) |

---

## Quickstart

> Requires Node 20+, a Supabase project with pgvector, a Clerk dev app, and Gemini / Adzuna / Tavily API keys.

```bash
# 1. Clone
git clone https://github.com/<you>/careerpilot.git
cd careerpilot

# 2. Install
npm install

# 3. Configure
cp .env.example .env.local
# fill in CLERK_*, SUPABASE_*, GEMINI_API_KEY, TAVILY_*, ADZUNA_*

# 4. Migrate the database
npx supabase db push   # or apply supabase/migrations/*.sql manually

# 5. Create the Storage bucket
# In Supabase Studio: New bucket "cvs" (private)

# 6. Run
npm run dev            # http://localhost:3000
```

Health-check commands:

```bash
npm run typecheck                                # tsc --noEmit
node scripts/smoke-rag.mjs                       # hits match_cv_chunks RPC
node scripts/smoke-tavily.ts                     # hits Tavily
node scripts/adzuna-probe.mjs                    # hits Adzuna
```

---

## Project tour

### 1. Job Hunter Agent
`POST /api/hunt` → `lib/agents/hunter.ts`
- **Input**: `targetRole`, `userId`, optional `location`/`remoteOnly`
- **Flow**: fan-out to 4 job-board adapters + a Tavily web-search call in parallel → dedupe on `(title, company_norm)` → re-rank by keyword overlap with the user's CV skills → return top 10 `JobCard`s
- **State**: a `hunter_runs` row is opened, a `hunter_saved` row per card the user keeps

### 2. CV RAG
`POST /api/cv/upload` (multipart) → `lib/cv/parse.ts` → `lib/cv/chunk.ts` → `lib/ai/embeddings.ts` → `cv_chunks` table with `vector(3072)`
- **Retrieval**: `match_cv_chunks(user_id, query_embedding, k=8, threshold=0.55)` RPC
- **Format support**: PDF (unpdf), DOCX (mammoth)
- **Status**: each CV has an `ingest_status` enum (`pending` / `parsing` / `chunking` / `embedding` / `ready` / `failed`)- **Cold-start warmup**: first dashboard render fires a best-effort `POST /api/cv/warmup` via `next/server`'s `after()` to pre-pay the ~22s Vercel Hobby cold-start. A placeholder `public/warmup.pdf` is ingested as a row tagged `__warmup__`, then immediately deleted. The CV upload UI is locked with a "Preparing your workspace…" state while warmup runs (`app/components/warmup-provider.tsx` polls `/api/cv/list?warmup=1`). The DB `__warmup__` row check is the cross-device gate — the warmup fires once per user, not once per browser.
### 3. Personal AI Assistant
`POST /api/chat/threads/[id]/messages` → `lib/agents/assistant.ts`
- **Router**: Gemini classifies the user message into one of 5 modes (`readiness` | `gap` | `roadmap` | `cover_letter` | `general`)
- **RAG**: every non-general mode retrieves the top-K CV chunks and injects them as evidence
- **Citations**: each response includes a `citations: { chunkId, excerpt }[]` payload the client renders as a "Sources" panel
- **Memory**: every exchange is persisted to `chat_messages` with the full history reloaded each turn
- **Structured output**: for `gap` and `roadmap`, the model returns JSON the client renders as cards/roadmaps

### 4. Fit-score
`POST /api/fit-score` → `lib/agents/fitScore.ts`
- **Formula**: `0.60 × skill_overlap + 0.30 × semantic_similarity + 0.10 × experience_edu_match`
- **Benchmark**: optional `benchmarkKey` (e.g. `frontend-engineer`) compares against a stored role profile, otherwise against the user's most recent CV
- **Persistence**: `fit_scores(jd_hash, jd_excerpt, score, breakdown, user_id)` — `jd_hash` dedupes repeats

### 5. Tracker, Calendar, Dashboard
- **Tracker**: drag-and-drop Kanban over `applications(status, history jsonb)` — drag = `PATCH /api/tracker/applications/[id]`
- **Calendar**: month grid, click a day → CRUD to-dos scoped to that day; goal deadlines render as diamonds
- **Dashboard**: server-rendered, reads `v_weekly_stats(user_id, week_start, apps_sent, todos_done, goals_total, goals_done, roadmap_pct)` in a single query

---

## Evaluation

A golden-case suite lives in [`evals/`](evals/). It runs **14 cases** against the live API and writes [`evals/results.md`](evals/results.md). The cases cover all four Codesprint Poridhi pillars:

| Pillar | Cases | What it asserts |
|---|---|---|
| **P1 — Hunter** | `hunter.basic` | ≥ 3 deduped `JobCard`s with title/company/url/source |
| **P2 — Fit-score** | `fit_score.strong_match`, `fit_score.weak_match` | programmatic score formula, benchmark resolution, JD-hash dedupe |
| **P3 — Assistant (RAG)** | `assistant.readiness`, `assistant.gap`, `assistant.roadmap`, `assistant.cover_letter`, `assistant.conversational_memory`, `assistant.off_topic_deflection`, `assistant.cv_rag_citations` | 5-intent router, citations on every non-general response, multi-turn memory, JSON contract for `gap`/`roadmap` |
| **P4 — Productivity & Tracker** | `productivity.todo_lifecycle`, `productivity.goal_create_and_track`, `productivity.kanban_flow`, `productivity.streak_stats` | CRUD on todos/goals/applications, Kanban status PATCH, `v_weekly_stats` shape |

Latest run: **84.7 % weighted (12 / 14 cases ≥ 0.75) — PASS** (threshold 70 %). See
[`evals/results.md`](evals/results.md) for the per-case detail and [`evals/README.md`](evals/README.md)
for the assertion schema, scoring rules, and how to author a new case.

```bash
# Terminal 1 — eval-bypass dev server (sets EVAL_BYPASS_AUTH=1, seeds the demo CV)
npm run dev:eval

# Terminal 2 — run the suite
npm run evals
# → evals/results.md is rewritten; runner exits non-zero if score < 70 %
```

To re-seed a fresh demo CV without restarting the server:

```bash
npx tsx scripts/seed-eval-cv.ts
```

---

## Repo map

See [`structure.md`](structure.md) for the full annotated tree. Highlights:

- `app/(dashboard)/` — all four product surfaces (CV · Hunter · Chat · Fit · Tracker · Calendar · Dashboard)
- `app/api/` — typed Next route handlers; no Express, no separate server. `app/api/cv/warmup` is the internal cold-start warmup route.
- `lib/agents/` — Hunter, Assistant router, Fit-score
- `lib/ai/` — model + embedding provider with circuit breaker
- `lib/cv/ingest.ts` — shared `ingestCv()` / `deleteCv()` / `WARMUP_NAME_PREFIX` used by both `/api/cv/upload` and `/api/cv/warmup`
- `lib/supabase/` — three clients (browser · server · service-role)
- `public/warmup.pdf` — 614-byte placeholder consumed by the warmup route
- `scripts/make-warmup-pdf.mjs` — one-shot generator for `public/warmup.pdf`
- `supabase/migrations/` — 12 SQL files, ordered by date (2026-06-05 → 2026-06-07)

---

## Design notes

- **Single RAG, four surfaces.** The CV is the truth source. The assistant cites it, the hunter prompt grounds on it, the fit-score reasons over it, and the chat history stays in the same `chat_messages` table.
- **No background workers.** CV ingestion is sync (≤ 26 s) inside the upload route; we considered Inngest but a single user rarely uploads more than 1 CV/min and the timeout covers the worst case.
- **Circuit breaker on the LLM.** `lib/ai/resilience.ts` opens on 3 consecutive 5xx and falls back to the economy model tier.
- **Programmatic fit-score, not LLM-only.** The weighted formula is auditable, deterministic, and cheap; we use Gemini only to normalise skills.
- **No vendor lock-in.** Every LLM call goes through `lib/ai/provider.ts`; swap Gemini for OpenAI in one file.
- **Cold-start is paid once, on first sign-in.** The `pdf-parse` + `gemini-embedding-2` import cost (~22s cold) is hidden behind a `__warmup__` placeholder ingest fired via `next/server`'s `after()` from the dashboard layout. The placeholder is deleted the moment the pipeline finishes. The first real upload the user makes then hits a warm cache.

---

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ | Clerk browser SDK |
| `CLERK_SECRET_KEY` | ✅ | Clerk server SDK |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon key (RLS-enforced) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service-role client (RLS bypass for inserts) |
| `GEMINI_API_KEY` | ✅ | Gemini 3 chat + embedding |
| `TAVILY_API_KEY` | ✅ | Tavily web search for Hunter |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | ✅ | Adzuna job board |

Never commit `.env.local`. Netlify environment variables are set in the Netlify dashboard.

---

## Team

Built in 8 hours, debugged in 72. I love vibe coding.For Codesprint, built with a lot of chats with puku and a small amount of sleep.
