# CareerPilot — Evaluation Results

- **Run at:** 2026-06-07T19:45:17.939Z
- **Base URL:** `http://localhost:3000`
- **Eval user:** `user_eval_demo`
- **Cases:** 14
- **Weighted score:** **8.3%**
- **Verdict:** ❌ FAIL (threshold 70%)
- **Duration:** 87.1 s

| # | Case | Surface | Score | Pass | Duration |
|---|---|---|---|---|---|
| 1 | `hunter.basic` | hunter | 0% | ❌ | 1535 ms |
| 2 | `fit_score.strong_match` | fit-score | 0% | ❌ | 922 ms |
| 3 | `fit_score.weak_match` | fit-score | 0% | ❌ | 471 ms |
| 4 | `assistant.readiness` | chat | 0% | ❌ | 769 ms |
| 5 | `assistant.gap` | chat | 0% | ❌ | 427 ms |
| 6 | `assistant.roadmap` | chat | 0% | ❌ | 405 ms |
| 7 | `assistant.cover_letter` | chat | 0% | ❌ | 423 ms |
| 8 | `assistant.conversational_memory` | chat | 0% | ❌ | 418 ms |
| 9 | `assistant.off_topic_deflection` | chat | 0% | ❌ | 473 ms |
| 10 | `assistant.cv_rag_citations` | chat | 0% | ❌ | 421 ms |
| 11 | `productivity.todo_lifecycle` | productivity | 25% | ❌ | 3779 ms |
| 12 | `productivity.goal_create_and_track` | productivity | 25% | ❌ | 1234 ms |
| 13 | `productivity.kanban_flow` | productivity | 25% | ❌ | 2133 ms |
| 14 | `productivity.streak_stats` | productivity | 50% | ❌ | 8068 ms |

## Detail

### ❌ hunter.basic — Hunter — basic fan-out (Pillar 1: Job Aggregation)

> **Error:** hunt failed: 401
- status=401

### ❌ fit_score.strong_match — Fit-score — strong match (Pillar 2: Semantic matching)

> **Error:** fit-score failed: 401
- status=401

### ❌ fit_score.weak_match — Fit-score — weak match (Pillar 2: Semantic matching)

> **Error:** fit-score failed: 401
- status=401

### ❌ assistant.readiness — Assistant — readiness verdict (Pillar 3: AI Career Coach)

> **Error:** thread create failed: 401 null

### ❌ assistant.gap — Assistant — gap analysis (Pillar 3: AI Career Coach)

> **Error:** thread create failed: 401 null

### ❌ assistant.roadmap — Assistant — 6-week roadmap (Pillar 3: AI Career Coach)

> **Error:** thread create failed: 401 null

### ❌ assistant.cover_letter — Assistant — cover letter (Pillar 3: AI Career Coach, user-visible long-form)

> **Error:** thread create failed: 401 null

### ❌ assistant.conversational_memory — Assistant — multi-turn memory (Pillar 3: AI Career Coach)

> **Error:** thread create failed: 401 null

### ❌ assistant.off_topic_deflection — Assistant — off-topic deflection (Pillar 3: AI Career Coach safety)

> **Error:** thread create failed: 401 null

### ❌ assistant.cv_rag_citations — Assistant — RAG grounded chat cites CV (Pillar 3: RAG-grounded responses)

> **Error:** thread create failed: 401 null

### ❌ productivity.todo_lifecycle — Productivity — todo create + complete (Pillar 4: To-do tracking)

- steps=4
-   ✗ step 1 POST /api/todos → status 500 == 200
-   ✗ step 1 POST /api/todos → top-level keys: [todo]
-   ✗ step 2 GET /api/todos?from=2026-06-01&to=2026-06-30 → status 500 == 200
-   ✗ step 2 GET /api/todos?from=2026-06-01&to=2026-06-30 → list.todos.length >= 1 (got 0)
-   ✗ step 3 PATCH /api/todos//done → status 500 == 200
-   ✗ step 3 PATCH /api/todos//done → top-level keys: [todo]
-   ✗ step 4 GET /api/todos?from=2026-06-01&to=2026-06-30 → status 500 == 200

### ❌ productivity.goal_create_and_track — Productivity — goal create + list (Pillar 4: SMART goal tracking)

- steps=2
-   ✗ step 1 POST /api/goals → status 500 == 200
-   ✗ step 1 POST /api/goals → top-level keys: [goal]
-   ✗ step 2 GET /api/goals?active=1 → status 500 == 200
-   ✗ step 2 GET /api/goals?active=1 → list.goals.length >= 1 (got 0)

### ❌ productivity.kanban_flow — Productivity — application kanban transitions (Pillar 4: Kanban board with history)

- steps=4
-   ✗ step 1 POST /api/tracker/applications → status 500 == 200
-   ✗ step 1 POST /api/tracker/applications → top-level keys: [application]
-   ✗ step 2 PATCH /api/tracker/applications/ → status 405 == 200
-   ✗ step 3 PATCH /api/tracker/applications/ → status 405 == 200
-   ✗ step 4 GET /api/tracker/applications/ → status 500 == 200
-   ✗ step 4 GET /api/tracker/applications/ → top-level keys: [application]

### ❌ productivity.streak_stats — Productivity — weekly stats surface (Pillar 4: streak + dashboard)

- steps=1
-   ✗ step 1 GET /api/productivity/stats?week=2026-W23 → status 404 == 200
-   ✗ step 1 GET /api/productivity/stats?week=2026-W23 → top-level keys: [stats, streak, roadmapPct]
