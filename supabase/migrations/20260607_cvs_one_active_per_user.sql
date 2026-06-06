-- Enforce "one active CV per user" at the DB level.
--
-- Background
-- ----------
-- The CV management page lets a user upload many CVs but only one is
-- "active" at a time. Everything RAG-side (chat assistant, fit-score
-- checker, job hunter) is meant to read from the active row only.
-- The application enforces this with a demote-then-promote flow in
-- PATCH /api/cv/[id], but that's a soft guarantee: a failed demote
-- (network blip, race between two PATCHes, a manual SQL write) would
-- leave two rows with is_active = true and break the RAG contract.
--
-- This partial unique index makes the invariant a hard DB-level
-- constraint. Postgres will reject the second INSERT/UPDATE that
-- would create a second active row for the same user, and the
-- demote-then-promote path becomes "demote, then promote, with the
-- promote step now guaranteed to succeed because no other active row
-- exists after the demote".

CREATE UNIQUE INDEX IF NOT EXISTS cvs_one_active_per_user
  ON public.cvs (user_id)
  WHERE is_active = true;
