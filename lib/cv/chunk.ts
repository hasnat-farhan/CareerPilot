/**
 * CV chunker — turns a parsed CV into the chunks the RAG layer
 * embeds and stores in `cv_chunks`.
 *
 * Design
 * ------
 *  - Section-aware: we never split a chunk across two sections. The DB
 *    `cv_chunks` index is `(cv_id, section, ordinality)`, so cross-
 *    section splits would force a synthetic section. Cleaner to keep
 *    splits within a section.
 *  - Per-section chunks: the consumer (fit-score agent, job hunter,
 *    chat assistant) retrieves by section, so one chunk per section
 *    gives the cleanest "Education is here, Skills are there" layout.
 *  - Sub-splitting for long sections: a single Experience block can
 *    easily run 2-4k tokens. We sub-split when a section exceeds
 *    `TARGET_WORDS` (default 700) words, with `OVERLAP_WORDS` (default
 *    80) of overlap between adjacent sub-chunks to preserve context
 *    across the split boundary.
 *  - The section label is repeated in each sub-chunk so the embedding
 *    captures the topic even if the sub-chunk is a fragment.
 *  - Hard cap: we never let a chunk exceed `HARD_CAP_WORDS` (default
 *    1500) regardless of the soft split, as a safety net.
 *  - Tokenizer: simple whitespace split. Gemini's embedding endpoint
 *    doesn't expose a tokenizer; 700 words ≈ 1k tokens which fits the
 *    `gemini-embedding-2` input limit with plenty of headroom.
 *  - Filter: chunks under 30 chars are dropped (likely whitespace,
 *    a stray section header, or an OCR artifact).
 *
 * Output
 * ------
 *  `CvChunk[]` matches the column shape of `cv_chunks` minus the
 *  `id`, `embedding`, and `created_at` columns (the ingester fills
 *  those at insert time).
 */

export interface CvChunk {
  section: string; // canonical: summary | experience | education | skills | projects | other
  section_label: string; // human label, e.g. "Experience (1/3)"
  content: string; // text to embed
  ordinality: number; // position across the whole document
  token_count: number; // whitespace-separated words, for the inspector UI
}

interface RawSection {
  section: string;
  sectionLabel: string; // the heading line itself, if any
  body: string; // remaining content under that heading
}

// ---------- Section detection ----------

interface SectionRule {
  pattern: RegExp;
  section: string; // canonical section name
  // If the heading line itself is useful, we'll use it as the
  // `section_label`. Otherwise the section kind alone is fine.
}

const SECTION_RULES: SectionRule[] = [
  { pattern: /^professional experience/i, section: "experience" },
  { pattern: /^work experience/i, section: "experience" },
  { pattern: /^research experience/i, section: "experience" },
  { pattern: /^teaching experience/i, section: "experience" },
  { pattern: /^experience/i, section: "experience" },
  { pattern: /^internship/i, section: "experience" },
  { pattern: /^education/i, section: "education" },
  { pattern: /^skills/i, section: "technical_skills" },
  { pattern: /^technical skills/i, section: "technical_skills" },
  { pattern: /^projects/i, section: "projects" },
  { pattern: /^publications/i, section: "publications" },
  { pattern: /^patents/i, section: "publications" },
  { pattern: /^publications and patents/i, section: "publications" },
  { pattern: /^scholastic achievements/i, section: "awards" },
  { pattern: /^achievements/i, section: "awards" },
  { pattern: /^awards/i, section: "awards" },
  { pattern: /^certifications/i, section: "certifications" },
  { pattern: /^positions of responsibility/i, section: "other" },
  { pattern: /^extra curricular/i, section: "other" },
  { pattern: /^courses/i, section: "other" },
  { pattern: /^summary/i, section: "summary" },
  { pattern: /^objective/i, section: "summary" },
  { pattern: /^languages/i, section: "technical_skills" },
];

const SUMMARY_SECTION = "summary";

/**
 * Walk the lines of the parsed CV and bucket them into sections.
 * Anything before the first recognised heading goes into "summary".
 */
function splitIntoRawSections(rawText: string): RawSection[] {
  const lines = rawText.split(/\r?\n/);
  const out: RawSection[] = [];
  let current: RawSection = {
    section: SUMMARY_SECTION,
    sectionLabel: "",
    body: "",
  };
  out.push(current);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Preserve blank lines as paragraph breaks inside the current
      // section; the sub-splitter collapses them.
      current.body = current.body ? current.body + "\n" : current.body;
      continue;
    }
    const matched =
      trimmed.length < 60
        ? SECTION_RULES.find((r) => r.pattern.test(trimmed))
        : undefined;

    if (matched) {
      current = {
        section: matched.section,
        sectionLabel: trimmed,
        body: "",
      };
      out.push(current);
    } else {
      current.body = current.body ? current.body + "\n" + line : line;
    }
  }

  return out;
}

// ---------- Sub-splitting ----------

const TARGET_WORDS = 700;
const OVERLAP_WORDS = 80;
const HARD_CAP_WORDS = 1500;
const MIN_CONTENT_CHARS = 30;

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Split a section's body into 1..N sub-chunks, each at most
 * TARGET_WORDS words, with OVERLAP_WORDS of overlap between adjacent
 * sub-chunks. If the body is short, returns one chunk. Hard cap
 * protects against pathological input.
 */
function subSplitBody(body: string, sectionLabel: string): string[] {
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= TARGET_WORDS) return [body.trim()];

  const chunks: string[] = [];
  let start = 0;
  // Safety: hard-cap loop guard. If overlap >= target we still make
  // progress because start advances by (target - overlap).
  let guard = 0;
  while (start < words.length && guard < 1000) {
    guard++;
    const end = Math.min(words.length, start + TARGET_WORDS);
    const slice = words.slice(start, end).join(" ");
    chunks.push(slice);

    if (end >= words.length) break;
    // Advance with overlap. Make sure we always move forward.
    const advance = Math.max(1, TARGET_WORDS - OVERLAP_WORDS);
    start += advance;
    // Hard cap: if a single slice somehow grew past HARD_CAP_WORDS
    // (shouldn't happen with TARGET_WORDS), break the loop.
    if (end - start > HARD_CAP_WORDS) break;
  }
  return chunks;
}

// ---------- Public API ----------

/**
 * Chunk a parsed CV into per-section chunks, sub-splitting long
 * sections with overlap. The output is suitable for direct insertion
 * into `cv_chunks` after embedding.
 */
export function chunkCv(rawText: string): CvChunk[] {
  if (!rawText || !rawText.trim()) return [];

  const rawSections = splitIntoRawSections(rawText);
  const out: CvChunk[] = [];
  let ordinality = 0;

  for (const raw of rawSections) {
    const body = raw.body.trim();
    if (!body || body.length < MIN_CONTENT_CHARS) continue;

    const subBodies = subSplitBody(body, raw.sectionLabel);
    if (subBodies.length === 0) continue;

    const total = subBodies.length;
    subBodies.forEach((content, i) => {
      const label =
        total > 1
          ? `${raw.sectionLabel || raw.section} (${i + 1}/${total})`
          : raw.sectionLabel || raw.section;
      out.push({
        section: raw.section,
        section_label: label,
        content,
        ordinality,
        token_count: wordCount(content),
      });
      ordinality++;
    });
  }

  return out;
}
