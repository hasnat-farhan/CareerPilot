-- CareerPilot: extend chat_messages for the Assistant router.
--
-- The Assistant (Pillar 3) can answer in five modes:
--   - readiness    : "am I ready for role X?"
--   - gap_analysis : "what am I missing for role X?"
--   - roadmap      : "build me a 6-week plan for role X"
--   - cover_letter : "draft a cover letter for role X at company Y"
--   - general      : RAG-grounded free chat (the default)
--
-- The specialised modes return *structured* data on top of the text
-- reply (e.g. a fit-score card, a weekly plan). We persist that payload
-- here so the client can re-render it on reload, and so future analytics
-- (which intents succeed?) don't have to re-parse text.
--
-- All new columns are NULLABLE so the migration is safe against existing
-- rows from the general-chat era.
--
-- Run via the Supabase SQL editor, or `supabase db push`.

alter table public.chat_messages
  add column if not exists mode text
    check (mode in ('readiness', 'gap_analysis', 'roadmap', 'cover_letter', 'general')),
  add column if not exists structured_result jsonb;

create index if not exists chat_messages_user_mode_idx
  on public.chat_messages (user_id, mode, created_at desc)
  where mode is not null;

comment on column public.chat_messages.mode is
  'Assistant mode that produced this model reply. NULL on user rows and on legacy model rows.';
comment on column public.chat_messages.structured_result is
  'Mode-specific payload (e.g. fit_score, roadmap weeks, cover-letter body). NULL for general mode.';
