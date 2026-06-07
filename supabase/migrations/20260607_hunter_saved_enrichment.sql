-- CareerPilot: enrich hunter_saved so saved jobs render with the same
-- fidelity as live hunt results.
--
-- The current schema only stores fit_score (int) and fit_reason (text),
-- which is fine for a quick badge but drops the breakdown, match
-- highlights, concerns, source, and the remote-fallback flag. The Saved
-- Jobs tab renders the same JobCard component as the live hunter, so
-- those columns need to round-trip.
--
-- All new columns are nullable / have defaults so existing rows survive
-- the upgrade untouched. RLS stays deny-all; the service-role client
-- (supabaseAdmin) keeps writing.
alter table public.hunter_saved
  add column if not exists description       text,
  add column if not exists match_highlights  jsonb,
  add column if not exists concerns          jsonb,
  add column if not exists breakdown         jsonb,
  add column if not exists source            text,
  add column if not exists is_remote_fallback boolean not null default false;

-- Helpful index for the "is this job still in my saved list?" check.
create index if not exists hunter_saved_user_saved_at_idx
  on public.hunter_saved (user_id, saved_at desc);
