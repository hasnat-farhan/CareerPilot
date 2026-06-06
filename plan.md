# Pillar 4 — Productivity & Progress Tracker

## What exists already (reuse, don't rewrite)

| File | State | Reuse plan |
|---|---|---|
| `app/(dashboard)/tracker/page.tsx` | Hardcoded 4-col kanban with 4 fake apps. | **Replace data layer only.** Keep the 4 columns and the card visuals, wire to real DB + add drag-and-drop + detail panel. |
| `app/(dashboard)/calendar/page.tsx` | Hardcoded 35-cell month grid + 4 hardcoded todos. | **Replace data layer only.** Keep the month grid + todo list visuals, wire to real DB + add CRUD. |
| `app/(dashboard)/dashboard/page.tsx` | Hardcoded 4 stat cards. | **Replace data layer only.** Keep the 4 cards and icons, read from `v_weekly_stats` view. |
| `app/(dashboard)/layout.tsx` | Sidebar with 8 items (no Goals, no Nudges). | **Add** "Goals" + "Nudges" (bell icon) entries. |
| `supabase/migrations/20260605_hunter.sql` | `hunter_saved` table already has `url, title, company, location, salary, deadline, fit_score, fit_reason` + a `unique (user_id, url)`. | **Wire:** "Apply" on a Hunter card inserts a row in new `applications` table referencing `hunter_saved.id`. |
| Existing `app/api/chat/threads`, `app/api/fit-score`, `app/api/hunt/*` | Already use the `requireUserId` + `supabaseAdmin` pattern. | **Mirror** that pattern for every new Pillar-4 route. |

## Scope split into 5 tracks

1. **Application Tracker** (Kanban with drag)
2. **Calendar & To-Dos** (month grid + per-day todos linked to goals)
3. **Goal Setting** (per-week / per-deadline goals with progress)
4. **Progress Dashboard** (live stats + streak)
5. **AI Nudges** (rule-based outbox + bell in topbar)

## Data model (one new migration)

`supabase/migrations/20260607_productivity.sql` — four tables + one view.

```
applications
  id          uuid pk
  user_id     text                  -- Clerk user id
  source_id   uuid?                 -- -> hunter_saved.id (optional, nullable for manual adds)
  company     text
  role        text
  url         text?
  location    text?
  salary      text?
  deadline    date?
  status      text check ('applied','interviewing','offer','rejected')
  notes       text?
  applied_at  date default now()
  status_updated_at timestamptz default now()
  -- history: a jsonb array of {status, at} appended on every PATCH

todos
  id          uuid pk
  user_id     text
  goal_id     uuid?                 -- -> goals.id
  application_id uuid?              -- -> applications.id
  title       text
  due_date    date
  done        bool default false
  done_at     timestamptz?
  created_at  timestamptz default now()

goals
  id          uuid pk
  user_id     text
  title       text
  type        text check ('count','one_shot')   -- "apply 5 jobs" vs "finish DSA course"
  target_count int?                             -- null for one_shot
  period      text check ('week','date')        -- "this week" or "by Sunday"
  due_date    date
  completed   bool default false
  completed_at timestamptz?
  created_at  timestamptz default now()

nudges
  id          uuid pk
  user_id     text
  kind        text                  -- 'no_applications' | 'goal_behind' | 'todo_overdue' | 'streak_break'
  title       text
  body        text
  cta_href    text?                 -- e.g. '/hunter?q=frontend%20engineer'
  read        bool default false
  created_at  timestamptz default now()
  -- one nudge per (user_id, kind, date_trunc('day', created_at)) via unique index
```

View: `v_weekly_stats(user_id, week_start, apps_sent, todos_done, goals_total, goals_done, roadmap_pct)` — pure SQL over the four tables.

Auth: same pattern as the other migrations. RLS deny-all, service-role client in the API.

## File layout

```
app/
  (dashboard)/
    tracker/page.tsx            # rewrite — live kanban with drag
    calendar/page.tsx           # rewrite — live month grid + todo CRUD
    dashboard/page.tsx          # rewrite — read v_weekly_stats
    goals/page.tsx              # NEW — goals CRUD page
    layout.tsx                  # add Goals + Bell (nudges) nav entries
  api/
    tracker/
      applications/route.ts                 # GET list, POST create (from hunter_saved or manual)
      applications/[id]/route.ts            # PATCH status/notes, DELETE
    todos/
      route.ts                              # GET week, POST create
      [id]/route.ts                         # PATCH done, DELETE
    goals/
      route.ts                              # GET active, POST create
      [id]/route.ts                         # PATCH complete, DELETE
    nudges/
      route.ts                              # GET unread
      [id]/read/route.ts                    # PATCH mark-read
      generate/route.ts                     # POST — runs the rule engine on demand

lib/
  productivity/
    types.ts                                # shared TS types
    nudges.ts                               # pure rule-engine function: (userStats) => NudgeDraft[]

supabase/migrations/20260607_productivity.sql
```

## Build order (lowest dependency first)

1. **SQL** — add the four tables + view. Verify with a `psql`-style smoke check via the Supabase JS client on dev.
2. **Tracker wire** — `applications` API + Hunter "Apply" button + drag-and-drop on the kanban. Unblocks: stats count, nudges "no apps this week".
3. **Todos** — calendar grid reads `deadline`/`due_date` from `todos`, `applications`, and `goals`. Add/check off. Unblocks: streak counter, todo-overdue nudges.
4. **Goals** — new `/goals` page. Wired into sidebar. Used as the source of truth for goal-pace nudges.
5. **Dashboard** — swap hardcoded stats for `v_weekly_stats`. Add a streak card.
6. **Nudges** — `lib/productivity/nudges.ts` is a pure function. `/api/nudges/generate` runs it, dedupes by (user, kind, day), inserts. Bell icon in topbar polls `/api/nudges`.

## Why this order

- SQL first → no JS imports break.
- Tracker before todos → applications count is the first stat shown; Hunter "Apply" is the first interaction.
- Todos before goals → goals need todo linkage to compute progress.
- Dashboard after both → it only reads aggregates.
- Nudges last → it reads everything else.

## Risks & open questions

- **Realtime vs polling**: nudge count uses polling (`/api/nudges` every 60s on the dashboard layout). Real-time channel deferred — not worth the wiring for v1.
- **Streak counter**: consecutive *calendar days* (in user's timezone, which we don't store) with `applications.status_updated_at` or `todos.done_at`. v1 uses UTC. Good enough; can localise later.
- **Drag-and-drop**: HTML5 DnD is enough — no react-dnd dep. Tested in Chrome/Edge; touch devices fall back to a "Move to…" menu on each card.
- **Roadmap % complete**: we have no `roadmap_progress` table yet; the AI assistant's roadmap cards live in `chat_messages.structured_result`. v1 surfaces a placeholder `0%` for that stat; the real number gets wired when the AI roadmaps are queryable.
- **Branch**: stay on `feature/chat-assistant` for now; we can branch to `feature/productivity-tracker` once SQL is in. No remote push yet.

## Acceptance check

- Build clean, dev runs, all 5 sub-features reachable from the sidebar.
- "Apply" on a Hunter card → row appears in Tracker under Applied; drag to Interviewing persists; refresh keeps it there.
- Calendar shows real todos for the current week; checking one off updates the streak.
- Dashboard cards match the underlying tables (smoke-check by hand).
- A user with zero apps this week sees a nudge in the bell by the next reload.
