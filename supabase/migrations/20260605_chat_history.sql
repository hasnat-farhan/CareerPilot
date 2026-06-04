-- CareerPilot: per-user chat history for the Assistant.
--
-- This migration is INDEPENDENT of the CV ingester. The chat route works
-- without `cv_chunks` existing; the RAG retrieval layer (lib/rag/retrieve-cv.ts)
-- returns an empty list until the CV feature ships.
--
-- Run in the Supabase SQL editor, or via:
--   supabase db push   (if you wire the CLI later)
--
-- AUTH MODEL
-- ----------
-- CareerPilot uses Clerk for auth and Supabase for storage. The two systems
-- are not federated by default, so a Supabase JWT won't carry the Clerk
-- user id. Instead, the API route at app/api/chat/* runs on the server with
-- SUPABASE_SERVICE_ROLE_KEY (which bypasses RLS) and enforces user
-- ownership in code before reading/writing. RLS is still enabled as a
-- defence-in-depth so the anon key can never read these rows directly.
-- If you later wire a Clerk -> Supabase JWT template, swap the `user_id`
-- check below for `auth.uid()` and remove the service-role bypass in
-- lib/supabase/server.ts.

create table if not exists public.chat_threads (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,                -- Clerk user id (e.g. "user_2x...")
  title       text not null default 'New chat',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists chat_threads_user_id_updated_at_idx
  on public.chat_threads (user_id, updated_at desc);

create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.chat_threads(id) on delete cascade,
  user_id     text not null,                -- denormalised for ownership check
  role        text not null check (role in ('user', 'model')),
  content     text not null,
  -- Optional RAG metadata for the model turns. Null for user turns.
  citations   jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists chat_messages_thread_id_created_at_idx
  on public.chat_messages (thread_id, created_at);

create index if not exists chat_messages_user_id_idx
  on public.chat_messages (user_id);

-- Auto-touch updated_at on the parent thread when a message is inserted.
create or replace function public.touch_chat_thread()
returns trigger
language plpgsql
as $$
begin
  update public.chat_threads
     set updated_at = now()
   where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists chat_messages_touch_thread on public.chat_messages;
create trigger chat_messages_touch_thread
  after insert on public.chat_messages
  for each row execute function public.touch_chat_thread();

-- Defence-in-depth: even though the API uses the service role, lock anon
-- access down so a leaked anon key can't read these rows.
alter table public.chat_threads  enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists chat_threads_deny_all on public.chat_threads;
create policy chat_threads_deny_all on public.chat_threads
  for all
  using  (false)
  with check (false);

drop policy if exists chat_messages_deny_all on public.chat_messages;
create policy chat_messages_deny_all on public.chat_messages
  for all
  using  (false)
  with check (false);
