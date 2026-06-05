-- CareerPilot: Fit-score persistence.
--
-- Stores one row per (user, jd_hash, benchmark_key) computation. The API
-- route reads the latest row for the dashboard; the chat assistant reads
-- by id when a user revisits a prior turn.
--
-- Auth model matches hunter_hunts / chat_messages: service-role client in
-- the API enforces user_id; RLS deny-all as defence-in-depth.
create table if not exists public.fit_scores (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  -- The role benchmark that drove the score, e.g. 'data-engineer'.
  -- Freeform (jd-only) calls store '_freeform'.
  benchmark_key text not null,
  -- Hash of the normalised JD so re-running the same JD is cheap.
  jd_hash       text not null,
  -- First 8 KB of the JD for the dashboard preview; full text stays in result.
  jd_excerpt    text,
  -- The full FitScoreResult JSON (score, matched, missing, etc).
  result        jsonb not null,
  computed_at   timestamptz not null default now()
);

create index if not exists fit_scores_user_recent_idx
  on public.fit_scores (user_id, computed_at desc);
create index if not exists fit_scores_user_jd_idx
  on public.fit_scores (user_id, jd_hash, computed_at desc);

-- ---------- RLS (deny-all to anon; service-role bypasses) ----------
alter table public.fit_scores enable row level security;
drop policy if exists fit_scores_deny_all on public.fit_scores;
create policy fit_scores_deny_all on public.fit_scores
  for all using (false) with check (false);
