-- =============================================================
-- CareerPilot: Pillar 2 — Profile & Resume Intelligence (RAG core)
-- Run in Supabase SQL Editor (one shot, idempotent)
-- =============================================================
--
-- Two tables back the CV intelligence pillar:
--   cvs        — one row per uploaded CV (or builder-saved CV).
--                A user may have many versions over time; only one is
--                `is_active = true` at a time. The active row is the
--                one the RAG retriever queries.
--   cv_chunks  — section-based embedded chunks of `cvs.raw_text`,
--                plus the OCR text and table payloads the chunker
--                extracted from any embedded images. One CV becomes
--                roughly 10–40 chunks.
--
-- Auth model
-- ----------
-- Matches the on-disk chat / hunter / fit-score migrations: `user_id`
-- is the raw Clerk user id (`user_2x...`). The API routes use the
-- service-role client in `lib/supabase/admin.ts` and enforce ownership
-- in code; RLS is enabled with deny-all as defence-in-depth so a
-- leaked anon key cannot read or write these rows.
--
-- If you later wire a Clerk → Supabase JWT template, swap the policies
-- below for `auth.uid()::text` checks. Until then, do not enable
-- direct-to-DB access from the browser.
--
-- Embedding dimension
-- -------------------
-- `cv_chunks.embedding` is `vector(3072)` because the Gemini provider
-- in `lib/ai/provider.ts` emits 3072-dim vectors from
-- `gemini-embedding-2`. A 1536-dim column would throw on the first
-- insert. If you switch the provider, update the column and the
-- `match_cv_chunks` / `replace_cv_chunks` RPC signatures in lockstep.
--
-- Note: NO vector index is created on this column. pgvector on
-- Supabase (current build) caps both ivfflat and hnsw at 2000
-- dimensions, so 3072-dim can't be indexed. The match_cv_chunks RPC
-- does a brute-force cosine scan filtered by user_id and the single
-- active CV — fine while chunk counts per user are in the tens. See
-- the "Vector index" section in the chunks table block for details.
--
-- Re-run safety
-- -------------
-- This migration is safe to re-run. The block below drops any
-- pre-existing `cvs` / `cv_chunks` tables that don't match the
-- Pillar 2 schema (e.g. the Pillar 1 hunter migration created
-- `cvs` with a uuid `user_id`, no `is_active`, and `vector(1536)`).
-- The Pillar 1 schema is incompatible with the Pillar 2 shape
-- (the user_id type changed from uuid to text, and the embedding
-- dimension changed from 1536 to 3072), so we can't ALTER in place
-- — we have to drop and recreate. If you have existing CV data you
-- want to preserve, back it up before running this migration.

do $$
declare
  v_has_is_active boolean;
begin
  -- If `cvs` doesn't exist at all, nothing to do; the new migration
  -- will create it from scratch.
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'cvs'
  ) then
    return;
  end if;

  -- Detect the Pillar 2 shape by checking for `is_active`. If it's
  -- missing, this is the legacy Pillar 1 schema and we drop both
  -- tables (cv_chunks cascades via the FK) so the rest of this
  -- migration can recreate them with the correct shape.
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cvs'
       and column_name = 'is_active'
  ) into v_has_is_active;

  if not v_has_is_active then
    raise notice 'Pillar 1 CV schema detected (no is_active column). Dropping public.cv_chunks and public.cvs so the Pillar 2 schema can take over. Any existing CV data will be lost — re-upload after the migration completes.';
    -- cv_chunks has an FK to cvs, so dropping cvs cascades. Drop
    -- cv_chunks explicitly first to make the intent obvious and to
    -- avoid relying on the cascade.
    drop table if exists public.cv_chunks cascade;
    drop table if exists public.cvs cascade;
  else
    -- Already Pillar 2. The rest of the migration is idempotent
    -- (create table if not exists, create or replace function,
    -- drop policy if exists) so re-running is a no-op.
    -- Clean up orphaned vector indexes from earlier failed runs that
    -- would otherwise sit on the table forever.
    drop index if exists public.cv_chunks_embedding_ivfflat;
    drop index if exists public.cv_chunks_embedding_hnsw;
    raise notice 'Pillar 2 CV schema already in place. Skipping drop.';
  end if;
end $$;

create extension if not exists "vector";

-- =============================================================
-- 1) cvs — one row per CV version
-- =============================================================
create table if not exists public.cvs (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,                  -- Clerk user id
  version       integer not null default 1,
  -- Storage path of the original upload, e.g. "user_2x.../uuid.pdf".
  -- Null for builder-saved CVs that never had a file.
  file_url      text,
  -- The file extension we parsed from ("pdf" | "docx" | null).
  source        text not null default 'upload'
                  check (source in ('upload', 'builder')),
  -- Plain-text extraction of the file. For builder CVs this is the
  -- serialised structured form. Null until the ingester has run.
  raw_text      text,
  -- Byte ranges per section, e.g. {"experience": [1200, 4800]}.
  -- Lets the chunker re-run on a single section after an edit without
  -- re-scanning the whole document. Populated by the parser.
  section_index jsonb,
  -- Storage paths of the per-page rendered images, when the source
  -- was a PDF. Used by the OCR path and surfaced as citation links.
  page_images   text[],
  -- Set by the parser/OCR pass when the text extraction was empty or
  -- the user uploaded scanned pages. Drives whether we re-prompt
  -- Gemini for OCR on the next ingest.
  needs_ocr     boolean not null default false,
  -- At most one active CV per user. Enforced by a partial unique
  -- index below. Toggling active is how edits are "published": we
  -- upsert the new version, mark it active, mark the previous one
  -- inactive, and the RAG retriever only sees the active row.
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists cvs_user_active_idx
  on public.cvs (user_id, is_active, created_at desc);

create index if not exists cvs_user_recent_idx
  on public.cvs (user_id, created_at desc);

-- Partial unique: a user has at most one `is_active = true` CV.
-- This is what makes "swap active CV" atomic.
create unique index if not exists cvs_one_active_per_user
  on public.cvs (user_id)
  where is_active = true;

-- =============================================================
-- 2) cv_chunks — section-based embedded chunks
-- =============================================================
create table if not exists public.cv_chunks (
  id          uuid primary key default gen_random_uuid(),
  cv_id       uuid not null references public.cvs(id) on delete cascade,
  user_id     text not null,                    -- denormalised for RLS
  -- One of the recognised section types. Anything we can't classify
  -- goes into 'other' so it still gets indexed and cited.
  section     text not null
                check (section in (
                  'summary', 'objective',
                  'experience', 'work_experience',
                  'education',
                  'skills', 'technical_skills',
                  'projects', 'certifications',
                  'publications', 'awards',
                  'image_ocr', 'other'
                )),
  -- Human-readable label for citations, e.g.
  -- "Experience > Acme Corp (2024)".
  section_label text not null,
  -- The chunk text. For table chunks this is the linearised markdown
  -- table; the structured form lives in `structured_payload`.
  content     text not null,
  -- Gemini embedding, 3072-dim. See file header.
  embedding   vector(3072) not null,
  ordinality  integer not null,                 -- position within section
  token_count integer not null,
  -- 'gemini' if the content came from OCR rather than direct text
  -- extraction. Null for chunks parsed from native PDF/DOCX text.
  ocr_source  text
                check (ocr_source is null or ocr_source in ('gemini', 'tesseract')),
  -- Storage path of the page image this chunk was derived from, when
  -- applicable. Surfaces in the chat citation UI as "view source page".
  source_image_url text,
  -- For chunks that represent a table (or other structured content),
  -- the original structure lives here. The vector index still uses
  -- `content`; this is for the chunk inspector UI to render the
  -- original layout.
  structured_payload jsonb,
  edited_at   timestamptz,                      -- null = untouched since first ingest
  created_at  timestamptz not null default now()
);

create index if not exists cv_chunks_cv_idx
  on public.cv_chunks (cv_id, section, ordinality);

create index if not exists cv_chunks_user_idx
  on public.cv_chunks (user_id);

-- Vector index: deliberately OMITTED.
--
-- pgvector on Supabase (currently bundled at <0.5.0) caps BOTH ivfflat
-- AND hnsw at 2000 dimensions. Our embeddings are 3072-dim from
-- gemini-embedding-2 (see file header), so neither index type can be
-- built on this column. The choices are:
--   1) reduce embedding dim (requires a different provider / model)
--   2) brute-force cosine scan at query time
-- We pick (2): each user has tens of chunks, not millions, and the
-- match_cv_chunks RPC already filters by `user_id = p_user_id` and
-- joins on the single active CV row, so the in-memory scan is
-- measured in microseconds. Revisit when either pgvector >=0.5.0
-- ships on Supabase (HNSW 3072-dim becomes valid) or chunk volume
-- per user crosses ~10k.

-- =============================================================
-- 3) touch_updated_at trigger
-- =============================================================
-- Same shape as the hunter migration's `touch_updated_at`, scoped
-- to `cvs` so chunk edits / OCR re-runs don't touch unrelated rows.
create or replace function public.touch_cvs_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_cvs_touch on public.cvs;
create trigger trg_cvs_touch
before update on public.cvs
for each row execute function public.touch_cvs_updated_at();

-- =============================================================
-- 4) RLS — deny-all to anon; service-role bypasses
-- =============================================================
alter table public.cvs       enable row level security;
alter table public.cv_chunks enable row level security;

drop policy if exists cvs_deny_all on public.cvs;
create policy cvs_deny_all on public.cvs
  for all using (false) with check (false);

drop policy if exists cv_chunks_deny_all on public.cv_chunks;
create policy cv_chunks_deny_all on public.cv_chunks
  for all using (false) with check (false);

-- =============================================================
-- 5) RPCs the ingester / RAG seam call
-- =============================================================

-- 5a) Vector similarity search over the user's ACTIVE CV only.
--     Called by `lib/rag/retrieve-cv.ts` on every chat turn.
--
-- IMPORTANT: drop any pre-existing overloads first. The Pillar 1
-- hunter migration defined `match_cv_chunks(p_user_id uuid, p_query
-- vector, p_top_k int)`; the Pillar 2 schema uses `text` for
-- `user_id` (because Clerk ids are `user_2x...` strings, not uuid).
-- `create or replace` only replaces a function when the *signature*
-- matches exactly — same name + same param NAMES + same param
-- TYPES in the same order. With `text` vs `uuid`, Postgres treats
-- these as distinct overloads and BOTH end up in the database.
-- PostgREST then refuses to disambiguate ("Could not choose the
-- best candidate function") and the chat RAG call 500s. Dropping
-- the old shape here makes the migration safe to re-run: any stale
-- Pillar 1 signature is removed before the new one is created.
drop function if exists public.match_cv_chunks(uuid, vector, integer);
drop function if exists public.match_cv_chunks(text, vector, integer);
create or replace function public.match_cv_chunks(
  p_user_id  text,
  p_query    vector(3072),
  p_top_k    int default 5
)
returns table (
  id            uuid,
  section       text,
  section_label text,
  content       text,
  source_image_url text,
  similarity    float
)
language sql stable
as $$
  select
    c.id,
    c.section,
    c.section_label,
    c.content,
    c.source_image_url,
    1 - (c.embedding <=> p_query) as similarity
  from public.cv_chunks c
  join public.cvs v on v.id = c.cv_id
  where c.user_id = p_user_id
    and v.is_active = true
  order by c.embedding <=> p_query
  limit p_top_k
$$;

-- 5b) Replace the chunks for a given (cv, sections) tuple in one
--     transaction. Called by the edit-and-re-embed flow in the
--     chunk inspector. Embedding happens API-side (we don't want
--     plpgsql calling out to Gemini); this RPC just does the
--     delete + insert atomically.
create or replace function public.replace_cv_chunks(
  p_cv_id    uuid,
  p_sections text[],
  p_chunks   jsonb
)
returns integer                              -- number of chunks inserted
language plpgsql
as $$
declare
  v_user_id  text;
  v_inserted integer;
begin
  -- Ownership check: refuse to touch chunks for a CV that doesn't
  -- belong to the caller's user_id. We don't pass user_id in as a
--  parameter here; instead we read it from the CV row. The API
--  route enforces user_id = auth userId BEFORE calling this RPC.
  select user_id into v_user_id
    from public.cvs
   where id = p_cv_id
   for update;
  if v_user_id is null then
    raise exception 'replace_cv_chunks: cv % not found', p_cv_id;
  end if;

  -- Delete the old chunks for the patched sections only. Anything
  -- outside p_sections stays untouched, which is what makes
  -- "edit one section" cheap.
  delete from public.cv_chunks
   where cv_id = p_cv_id
     and section = any(p_sections);

  -- Insert the new chunks. Shape of each jsonb element:
  --   {section, section_label, content, embedding (number[]),
  --    ordinality, token_count, ocr_source?, source_image_url?,
  --    structured_payload?, edited_at?}
  insert into public.cv_chunks
    (cv_id, user_id, section, section_label, content, embedding,
     ordinality, token_count, ocr_source, source_image_url,
     structured_payload, edited_at)
  select
    p_cv_id,
    v_user_id,
    (elem->>'section')::text,
    (elem->>'section_label')::text,
    (elem->>'content')::text,
    -- pgvector accepts a float8[] cast to vector. The 3072-dim check
    -- happens implicitly on insert.
    (elem->>'embedding')::vector(3072),
    (elem->>'ordinality')::int,
    (elem->>'token_count')::int,
    elem->>'ocr_source',
    elem->>'source_image_url',
    elem->'structured_payload',
    -- Default edited_at to now() if the caller didn't set it.
    case
      when elem ? 'edited_at' and elem->>'edited_at' is not null
        then (elem->>'edited_at')::timestamptz
      else now()
    end
  from jsonb_array_elements(p_chunks) as elem;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end $$;

-- =============================================================
-- Done. Verify with:
--   \d public.cvs
--   \d public.cv_chunks
--   select proname from pg_proc where proname in ('match_cv_chunks','replace_cv_chunks');
-- =============================================================
