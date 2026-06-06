-- CareerPilot: Productivity & Progress Tracker (Pillar 4).
--
-- Four tables + one view:
--   applications  - Kanban: Applied / Interviewing / Offer / Rejected
--   todos         - Per-day to-dos, optionally linked to a goal or an application
--   goals         - Per-week or per-deadline goals (count or one-shot)
--   v_weekly_stats- Server-side aggregate read by the Dashboard
--
-- Same auth model as the other migrations: service-role client in
-- the API enforces user_id; RLS deny-all as defence-in-depth.
--
-- Idempotent: safe to re-run. Each CREATE uses IF NOT EXISTS and each
-- policy uses DROP POLICY IF EXISTS so a partial apply is recoverable.
--
-- NOTE: We deliberately do NOT call `create extension pgcrypto` here.
-- On Supabase Cloud, extensions must be enabled via the dashboard and
-- `gen_random_uuid()` is available in pg_catalog by default (PG13+).
-- The earlier migrations in this repo follow the same convention.

-- =========================================================================
-- applications
-- =========================================================================

create table if not exists public.applications (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  -- Optional link to a hunter_saved bookmark. Stored as a plain UUID
  -- (no FK) so this migration doesn't depend on the hunter schema
  -- being present. The API layer treats it as a soft reference.
  source_id     uuid,
  company       text not null,
  role          text not null,
  url           text,
  location      text,
  salary        text,
  deadline      date,
  status        text not null default 'applied'
                  check (status in ('applied','interviewing','offer','rejected')),
  notes         text,
  applied_at    date not null default current_date,
  -- Updated whenever status changes; the streak counter reads this.
  status_updated_at timestamptz not null default now(),
  -- Append-only history: array of {status, at} entries.
  history       jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists applications_user_recent_idx
  on public.applications (user_id, status_updated_at desc);

create index if not exists applications_user_status_idx
  on public.applications (user_id, status);

-- Prevent the same (user, url) being added twice.
create unique index if not exists applications_user_url_uniq
  on public.applications (user_id, url)
  where url is not null;

-- =========================================================================
-- goals  (defined BEFORE todos so the todos.goal_id FK resolves)
-- =========================================================================

create table if not exists public.goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  title         text not null,
  -- 'count'   : "Apply to 5 jobs this week" (target_count not null)
  -- 'one_shot': "Finish DSA course by Friday" (target_count null)
  type          text not null check (type in ('count','one_shot')),
  target_count  integer,
  -- 'week' : due_date is end-of-week (Sunday)
  -- 'date' : due_date is the exact target date
  period        text not null check (period in ('week','date')),
  due_date      date not null,
  completed     boolean not null default false,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists goals_user_due_idx
  on public.goals (user_id, due_date);

create index if not exists goals_user_open_idx
  on public.goals (user_id, completed);

-- =========================================================================
-- todos  (FKs to public.goals + public.applications)
-- =========================================================================

create table if not exists public.todos (
  id             uuid primary key default gen_random_uuid(),
  user_id        text not null,
  goal_id        uuid references public.goals(id)        on delete set null,
  application_id uuid references public.applications(id) on delete set null,
  title          text not null,
  due_date       date not null,
  done           boolean not null default false,
  done_at        timestamptz,
  -- Idempotency: if the assistant posts the same logical todo twice
  -- within a day, the second insert is rejected.
  dedupe_key     text,
  created_at     timestamptz not null default now()
);

create index if not exists todos_user_due_idx
  on public.todos (user_id, due_date);

create index if not exists todos_user_done_idx
  on public.todos (user_id, done);

create unique index if not exists todos_user_dedupe_uniq
  on public.todos (user_id, dedupe_key)
  where dedupe_key is not null;

-- =========================================================================
-- v_weekly_stats
-- =========================================================================
-- Per-user rolling week. Returns ONE row per user covering the current
-- calendar week (UTC, Mon..Sun) with the figures the Dashboard cards need.
--
-- Notes:
--   - apps_sent     = count of applications moved to ANY status this week
--                     (we count by status_updated_at; that captures
--                      both initial apply and any subsequent moves).
--   - todos_done    = count of todos marked done this week (done_at).
--   - goals_total   = count of goals whose due_date falls in this week.
--   - goals_done    = of those, how many are completed.
--   - roadmap_pct   = placeholder 0; will be replaced once the AI
--                     roadmaps become queryable (see plan.md).
--
-- We UNION the distinct user_ids that touched any of the three tables
-- this week, then aggregate per user. Users with zero activity this
-- week still appear with zeroes (LEFT JOIN'd below).

create or replace view public.v_weekly_stats as
with bounds as (
  select
    date_trunc('week', now())                       as week_start,
    date_trunc('week', now()) + interval '7 days'  as week_end
),
active_users as (
  select user_id from public.applications
    where status_updated_at >= (select week_start from bounds)
      and status_updated_at <  (select week_end   from bounds)
  union
  select user_id from public.todos
    where done and done_at >= (select week_start from bounds)
                     and done_at <  (select week_end   from bounds)
  union
  select user_id from public.goals
    where due_date >= (select week_start from bounds)::date
      and due_date <  (select week_end   from bounds)::date
)
select
  u.user_id,
  (select week_start from bounds) as week_start,
  coalesce((
    select count(*) from public.applications a, bounds b
    where a.user_id = u.user_id
      and a.status_updated_at >= b.week_start
      and a.status_updated_at <  b.week_end
  ), 0) as apps_sent,
  coalesce((
    select count(*) from public.todos t, bounds b
    where t.user_id = u.user_id
      and t.done
      and t.done_at >= b.week_start
      and t.done_at <  b.week_end
  ), 0) as todos_done,
  coalesce((
    select count(*) from public.goals g, bounds b
    where g.user_id = u.user_id
      and g.due_date >= b.week_start::date
      and g.due_date <  b.week_end::date
  ), 0) as goals_total,
  coalesce((
    select count(*) from public.goals g, bounds b
    where g.user_id = u.user_id
      and g.completed
      and g.due_date >= b.week_start::date
      and g.due_date <  b.week_end::date
  ), 0) as goals_done,
  0::int as roadmap_pct
from active_users u;

-- =========================================================================
-- RLS (deny-all; service-role bypasses)
-- =========================================================================

alter table public.applications enable row level security;
alter table public.todos        enable row level security;
alter table public.goals         enable row level security;

drop policy if exists applications_deny_all on public.applications;
create policy applications_deny_all on public.applications
  for all using (false) with check (false);

drop policy if exists todos_deny_all on public.todos;
create policy todos_deny_all on public.todos
  for all using (false) with check (false);

drop policy if exists goals_deny_all on public.goals;
create policy goals_deny_all on public.goals
  for all using (false) with check (false);

-- =========================================================================
-- Self-test  (should return 3 rows: applications, todos, goals)
-- =========================================================================
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('applications', 'todos', 'goals')
order by table_name;
