-- Adds a user-facing display label to cvs.
--
-- `name` is purely cosmetic — the chat agent only reads cv_chunks, never
-- this column. Users can rename a CV from the CV page; the upload route
-- sets a sensible default at insert time (the original filename) so the
-- list view never shows "Untitled".
--
-- Idempotent so this migration can be re-applied to a dev DB safely.

alter table public.cvs
  add column if not exists name text;

-- Optional: surface an index for a future "search by name" query.
-- `gin_trgm_ops` is provided by the `pg_trgm` extension, which is
-- not enabled by the base `vector` extension. Enable it here so
-- this migration is self-contained; the `if not exists` guard
-- keeps it a no-op when the extension is already present.
create extension if not exists pg_trgm;

create index if not exists cvs_name_trgm_idx
  on public.cvs using gin (name gin_trgm_ops)
  where name is not null;
