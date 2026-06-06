-- ============================================================
-- CareerPilot: Pillar 2 addendum — CV storage bucket
-- Run in Supabase SQL Editor (one shot, idempotent)
-- ============================================================
--
-- Creates the private `cvs` bucket that the upload API writes
-- to. The service-role client bypasses RLS, so users never
-- read these files directly from the browser — the API route
-- streams them down after the user_id check.
--
-- Idempotency: `insert ... on conflict do nothing` for the
-- bucket; policies use `drop ... if exists` first.
--
-- Note: this migration uses the `storage` schema which is
-- managed by Supabase. If the Supabase project is fresh,
-- `storage.buckets` and `storage.objects` exist already; if
-- not, the insert will succeed once Storage is enabled in
-- the dashboard.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cvs',
  'cvs',
  false,
  -- 20 MB. Most CVs are <2 MB; the cap gives headroom for
  -- design-heavy PDFs and rejects obvious abuse.
  20 * 1024 * 1024,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

-- ============================================================
-- Done. Verify with:
--   select * from storage.buckets where id = 'cvs';
-- ============================================================
