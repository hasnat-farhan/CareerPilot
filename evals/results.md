# CareerPilot — Evaluation Results

- **Run at:** 2026-06-08T18:31:21.553Z
- **Base URL:** `http://localhost:3000`
- **Eval user:** `user_eval_demo`
- **Cases:** 14
- **Weighted score:** **84.7%**
- **Verdict:** ✅ PASS (threshold 70%)
- **Duration:** 200.3 s

| # | Case | Surface | Score | Pass | Duration |
|---|---|---|---|---|---|
| 1 | `hunter.basic` | hunter | 100% | ✅ | 1413 ms |
| 2 | `fit_score.strong_match` | fit-score | 100% | ✅ | 3735 ms |
| 3 | `fit_score.weak_match` | fit-score | 50% | ❌ | 4268 ms |
| 4 | `assistant.readiness` | chat | 75% | ✅ | 19601 ms |
| 5 | `assistant.gap` | chat | 75% | ✅ | 24098 ms |
| 6 | `assistant.roadmap` | chat | 0% | ❌ | 8477 ms |
| 7 | `assistant.cover_letter` | chat | 100% | ✅ | 14022 ms |
| 8 | `assistant.conversational_memory` | chat | 100% | ✅ | 19755 ms |
| 9 | `assistant.off_topic_deflection` | chat | 75% | ✅ | 18183 ms |
| 10 | `assistant.cv_rag_citations` | chat | 100% | ✅ | 10977 ms |
| 11 | `productivity.todo_lifecycle` | productivity | 100% | ✅ | 2959 ms |
| 12 | `productivity.goal_create_and_track` | productivity | 100% | ✅ | 1475 ms |
| 13 | `productivity.kanban_flow` | productivity | 75% | ✅ | 4348 ms |
| 14 | `productivity.streak_stats` | productivity | 100% | ✅ | 1298 ms |

## Detail

### ✅ hunter.basic — Hunter — basic fan-out (Pillar 1: Job Aggregation)

- status=200
- cards=8
-   ✓ >= 3 results
-   ✓ <= 10 results
-   ✓ every card has [title, company, url, source]
-   ✓ unique by [title, company]

### ✅ fit_score.strong_match — Fit-score — strong match (Pillar 2: Semantic matching)

- status=200
- score=89
-   ✓ score in [70, 100]
-   ✓ breakdown keys: [skillOverlap, semantic, experience]

### ❌ fit_score.weak_match — Fit-score — weak match (Pillar 2: Semantic matching)

- status=200
- score=56
-   ✗ score in [0, 40]
-   ✓ breakdown keys: [skillOverlap, semantic, experience]

### ✅ assistant.readiness — Assistant — readiness verdict (Pillar 3: AI Career Coach)

- thread=22b46a00-da73-456d-8080-75fa1f4972c5
- mode=readiness
- reply.length=159
- citations=0
-   ✓ mode == readiness
-   ✓ reply contains any of [ready, strong, gap, senior, verdict, headline, next action]
-   ✗ structured keys: [verdict, headline, nextAction, buckets]

### ✅ assistant.gap — Assistant — gap analysis (Pillar 3: AI Career Coach)

- thread=d5b89910-bee9-434f-ad5c-7ea6b748e31d
- mode=gap_analysis
- reply.length=108
- citations=0
-   ✓ mode == gap_analysis
-   ✓ reply contains any of [gap, improve, learn, build, missing, strength]
-   ✗ structured keys: [summary, topGaps]

### ❌ assistant.roadmap — Assistant — 6-week roadmap (Pillar 3: AI Career Coach)

> **Error:** message POST failed: 502 {"error":"[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [503 Service Unavailable] This model is currently ex
- thread=13a0b247-3378-4afd-89c8-41b4de5d580c

### ✅ assistant.cover_letter — Assistant — cover letter (Pillar 3: AI Career Coach, user-visible long-form)

- thread=572a89cd-cabd-45df-9ffc-1933e48641d9
- mode=cover_letter
- reply.length=590
- citations=0
-   ✓ mode == cover_letter
-   ✓ reply contains any of [dear, sincerely, regards, thank you, hiring, team, subject]
-   ✓ reply length >= 250

### ✅ assistant.conversational_memory — Assistant — multi-turn memory (Pillar 3: AI Career Coach)

- thread=1c56575e-ddfb-4ba4-a56e-b344d2731b91
- mode=general
- reply.length=558
- citations=5
-   ✓ mode == general
-   ✓ reply contains all of [sarah, 5]
-   ✓ citations >= 0

### ✅ assistant.off_topic_deflection — Assistant — off-topic deflection (Pillar 3: AI Career Coach safety)

- thread=c11af02a-1733-485c-bbfc-722fcc7b80d8
- mode=general
- reply.length=1237
- citations=5
-   ✓ mode == general
-   ✗ reply contains any of [career, job, cv, i can help, career-related]
-   ✓ citations >= 0

### ✅ assistant.cv_rag_citations — Assistant — RAG grounded chat cites CV (Pillar 3: RAG-grounded responses)

- thread=6cfdb94c-90cb-4ab4-bd7b-1fb858283b1b
- mode=general
- reply.length=534
- citations=5
-   ✓ mode == general
-   ✓ reply contains any of [38%, lcp, acme, 200k, mau]
-   ✓ citations >= 1

### ✅ productivity.todo_lifecycle — Productivity — todo create + complete (Pillar 4: To-do tracking)

- steps=4
-   ✓ step 1 POST /api/todos → status 200 == 200
-   ✓ step 1 POST /api/todos → top-level keys: [todo]
-   ✓ step 2 GET /api/todos?from=2026-06-01&to=2026-06-30 → status 200 == 200
-   ✓ step 2 GET /api/todos?from=2026-06-01&to=2026-06-30 → list.todos.length >= 1 (got 9)
-   ✓ step 3 PATCH /api/todos/b2c9ee12-1209-4fdd-827d-4e8245f95d50/done → status 200 == 200
-   ✓ step 3 PATCH /api/todos/b2c9ee12-1209-4fdd-827d-4e8245f95d50/done → top-level keys: [todo]
-   ✓ step 4 GET /api/todos?from=2026-06-01&to=2026-06-30 → status 200 == 200
-   ✓ step 4 GET /api/todos?from=2026-06-01&to=2026-06-30 → every item has [done]

### ✅ productivity.goal_create_and_track — Productivity — goal create + list (Pillar 4: SMART goal tracking)

- steps=2
-   ✓ step 1 POST /api/goals → status 200 == 200
-   ✓ step 1 POST /api/goals → top-level keys: [goal]
-   ✓ step 2 GET /api/goals?active=1 → status 200 == 200
-   ✓ step 2 GET /api/goals?active=1 → list.goals.length >= 1 (got 7)
-   ✓ step 2 GET /api/goals?active=1 → every item completed == false

### ✅ productivity.kanban_flow — Productivity — application kanban transitions (Pillar 4: Kanban board with history)

- steps=4
-   ✓ step 1 POST /api/tracker/applications → status 200 == 200
-   ✓ step 1 POST /api/tracker/applications → top-level keys: [application]
-   ✗ step 1 POST /api/tracker/applications → status field == applied (got offer)
-   ✓ step 2 PATCH /api/tracker/applications/b58c1a9d-7d34-46c3-b36a-542d9c041c8a → status 200 == 200
-   ✓ step 2 PATCH /api/tracker/applications/b58c1a9d-7d34-46c3-b36a-542d9c041c8a → status field == interviewing (got interviewing)
-   ✓ step 3 PATCH /api/tracker/applications/b58c1a9d-7d34-46c3-b36a-542d9c041c8a → status 200 == 200
-   ✓ step 3 PATCH /api/tracker/applications/b58c1a9d-7d34-46c3-b36a-542d9c041c8a → status field == offer (got offer)
-   ✓ step 4 GET /api/tracker/applications/b58c1a9d-7d34-46c3-b36a-542d9c041c8a → status 200 == 200
-   ✓ step 4 GET /api/tracker/applications/b58c1a9d-7d34-46c3-b36a-542d9c041c8a → top-level keys: [application]
-   ✓ step 4 GET /api/tracker/applications/b58c1a9d-7d34-46c3-b36a-542d9c041c8a → status field == offer (got offer)
-   ✓ step 4 GET /api/tracker/applications/b58c1a9d-7d34-46c3-b36a-542d9c041c8a → history length >= 2 (got 5)

### ✅ productivity.streak_stats — Productivity — weekly stats surface (Pillar 4: streak + dashboard)

- steps=1
-   ✓ step 1 GET /api/productivity/stats?week=2026-W23 → status 200 == 200
-   ✓ step 1 GET /api/productivity/stats?week=2026-W23 → top-level keys: [stats, streak, roadmapPct]
