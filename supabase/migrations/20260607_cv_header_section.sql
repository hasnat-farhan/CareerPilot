-- =============================================================
-- Add `header` as a valid cv_chunks.section value.
--
-- The chunker now splits off the contact-info block (name, email,
-- phone, GitHub, LinkedIn, location) at the very top of a CV into
-- a dedicated `header` chunk so it never gets mis-bucketed into
-- `experience` (the contact line used to land in the first
-- experience bucket when an `EXPERIENCE` heading appeared close
-- to it, producing the 12-token "experience" chunk that was
-- visually all contact info).
--
-- Forward-only: this is a new value in the check constraint, so
-- the migration is safe to apply against existing data. Old CVs
-- that already have rows in `cv_chunks` keep their `section`
-- values; new uploads get `header` chunks for the contact block.
-- =============================================================

alter table public.cv_chunks
  drop constraint if exists cv_chunks_section_check;

alter table public.cv_chunks
  add constraint cv_chunks_section_check
  check (section in (
    'header',
    'summary', 'objective',
    'experience', 'work_experience',
    'education',
    'skills', 'technical_skills',
    'projects', 'certifications',
    'publications', 'awards',
    'image_ocr', 'other'
  ));
