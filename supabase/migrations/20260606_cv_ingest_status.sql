-- ============================================================
-- CareerPilot: Pillar 2 addendum — CV ingestion lifecycle columns
-- Run in Supabase SQL Editor (one shot, idempotent)
-- ============================================================
--
-- The Pillar 2 migration created `cvs` with the columns the
-- static schema needs. This addendum adds two columns the
-- ingester needs to report progress:
--
--   status         text  — 'processing' | 'ready' | 'failed'
--   error_message  text  — populated on failure, cleared on retry
--
-- The chat/hunter/fit-score routes don't read these columns
-- (they join on `is_active = true` regardless of status), so
-- an in-progress CV just appears as "not yet indexed" — the
-- retriever returns []. Adding a `status = 'ready'` filter to
-- those routes is a future change once we have a UI affordance
-- to surface the lifecycle.
--
-- Re-run safety: every DDL is `if not exists` / `drop ... if exists`.

alter table public.cvs
  add column if not exists status text not null default 'ready'
    check (status in ('processing', 'ready', 'failed'));

alter table public.cvs
  add column if not exists error_message text;

-- Index lets the upload API quickly enumerate "still
-- processing" rows for housekeeping. (Future cron.)
create index if not exists cvs_status_idx
  on public.cvs (status, updated_at desc)
  where status <> 'ready';

-- ============================================================
-- Done. Verify with:
--   \d public.cvs
-- ============================================================
