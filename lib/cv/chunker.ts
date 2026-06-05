/**
 * CV chunker — turns a parsed CV into the chunks the RAG layer
 * embeds and stores in `cv_chunks`.
 *
 * Design choices
 * --------------
 *  - Section-aware: we never split a chunk across two sections.
 *    The DB `cv_chunks` index is `(cv_id, section, ordinality)`, so
 *    cross-section splits would force us to invent a synthetic
 *    section. Cleaner to keep splits within a section.
 *  - Token budget: ~500 tokens per chunk with 100 tokens of overlap
 *    with the previous chunk in the same section. We use a simple
 *    whitespace tokenizer (the embedder is Gemini and doesn't
 *    expose a tokenizer; exact token counts aren't critical for
 *    retrieval quality at this size). 500 ≈ 1 page of dense CV
 *    prose.
 *  - Tables: if a section's body contains a markdown/pipe table,
 *    the table stays as one chunk regardless of size, and we copy
 *    it into `structured_payload` so the chunk inspector UI can
 *    render the original layout. The linearised text goes into
 *    `content` for embedding.
 *  - Labels: the parser leaves `label` empty; we fill it here with
 *    either the section kind ("Skills") or "Skills > Python, AWS"
 *    when the section's first non-empty body line gives us a
 *    useful qualifier.
 *
 * Output
 * ------
 *  `Chunk[]` matches the column shape of `cv_chunks` minus the
 *  `id`, `embedding`, and `created_at` columns (the ingester fills
 *  those at insert time).
 */

import {
  type ParsedSection,
  type ParserOutput,
  extractSubsectionLabel,
} from "@/lib/cv/parser";

// ---------- Public types ----------

/**
 * Shape of a single chunk ready to be embedded and inserted. The
 * `embedding` field is filled in by the ingester (Phase 4) — we
 * leave it out here so the chunker stays pure.
 */
export interface CvChunk {
  /** The DB primary key, generated client-side so the ingester can upsert deterministically. */
  id: string;
  /** The CV row this chunk belongs to. Set by the ingester. */
  cvId: string;
  /** The user id (denormalised for RLS). Set by the ingester. */
  userId: string;
  /** Section kind (matches the `section` check constraint). */
  section: string;
  /** Human-readable label, e.g. "Experience > Acme Corp (2024)". */
  sectionLabel: string;
  /** Chunk text. Newlines preserved. */
  content: string;
  /** Ordinality within the section: 0 for the first chunk, 1 for the second, etc. */
  ordinality: number;
  /** Approximate token count, used for analytics + budgeting. */
  tokenCount: number;
  /** Storage path of the source page image, if any. */
  sourceImageUrl: string | null;
  /**
   * For table-shaped chunks, the original structure. For prose
   * chunks this is null.
   */
  structuredPayload: Record<string, unknown> | null;
}

// ---------- Knobs ----------

/** Target tokens per chunk. ~500 is a good balance for Gemini embeddings. */
const TARGET_TOKENS = 500;
/** Overlap with the previous chunk in tokens. */
const OVERLAP_TOKENS = 100;
/** Hard cap: a single chunk can never exceed this many tokens. */
const HARD_CAP_TOKENS = 800;

// ---------- Token estimation ----------

/**
 * Cheap whitespace tokenizer. We could pull in `gpt-tokenizer` or
 * `tiktoken` for exact counts, but the ingester batched-embed cost
 * dominates and we don't need precision at the chunk boundary.
 *
 * Rule of thumb for English CV prose: 1 token ≈ 4 characters or
 * 0.75 words. We blend both for stability.
 */
export function estimateTokens(s: string): number {
  const words = s.split(/\s+/).filter(Boolean).length;
  const chars = s.length;
  return Math.ceil(Math.max(words * 1.33, chars / 4));
}

// ---------- Splitters ----------

/**
 * Split a long string into overlapping windows of roughly
 * `targetTokens` characters, with `overlapTokens` of overlap. We
 * prefer paragraph boundaries (blank lines) and fall back to
 * sentence boundaries, then to hard cuts.
 */
function splitByTokens(text: string, targetTokens: number, overlapTokens: number): string[] {
  const total = estimateTokens(text);
  if (total <= targetTokens) return [text];

  // Approximate character budgets (token estimate is char/4).
  const charBudget = targetTokens * 4;
  const charOverlap = overlapTokens * 4;
  const charHardCap = HARD_CAP_TOKENS * 4;

  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + charBudget, text.length);

    if (end < text.length) {
      // Try a paragraph break first (last \n\n within the window).
      const para = text.lastIndexOf("\n\n", end);
      if (para > cursor + charBudget * 0.5) {
        end = para;
      } else {
        // Try a sentence break (". " or ".\n" within the window).
        const sent = text.lastIndexOf(". ", end);
        if (sent > cursor + charBudget * 0.5) {
          end = sent + 1; // keep the period
        }
      }
    }

    const slice = text.slice(cursor, end).trim();
    if (slice.length > 0) out.push(slice);

    if (slice.length >= charHardCap) {
      // Hard cap hit: advance by the full window, no overlap, to
      // avoid infinite-loop pathology on input with no breaks.
      cursor = end;
    } else {
      cursor = Math.max(end - charOverlap, cursor + 1);
    }
  }
  return out;
}

// ---------- Table handling ----------

/**
 * Heuristic: is this body a markdown/pipe table? We reuse the same
 * `looksLikeTable` rule the parser used; if so, we keep the whole
 * body as one chunk regardless of length, and copy the rows into
 * `structured_payload`.
 */
function tableRows(body: string): string[][] | null {
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  if (!/\|/.test(lines[0]!)) return null;
  // Find the separator line, if any.
  const sepIdx = lines.findIndex((l) => /^\s*\|?\s*:?-{2,}:?/.test(l));
  if (sepIdx === -1) return null;
  const header = lines[sepIdx - 1];
  if (!header || !/\|/.test(header)) return null;
  const split = (l: string) =>
    l
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  return [
    split(header),
    ...lines.slice(sepIdx + 1).filter((l) => l.includes("|")).map(split),
  ];
}

// ---------- Per-section chunking ----------

function composeLabel(section: ParsedSection): string {
  if (section.kind === "summary" || section.kind === "objective") {
    return humaniseKind(section.kind);
  }
  const sub = extractSubsectionLabel(section.body);
  return sub ? `${humaniseKind(section.kind)} > ${sub}` : humaniseKind(section.kind);
}

function humaniseKind(kind: string): string {
  switch (kind) {
    case "summary":
      return "Summary";
    case "objective":
      return "Objective";
    case "experience":
    case "work_experience":
      return "Experience";
    case "education":
      return "Education";
    case "skills":
      return "Skills";
    case "technical_skills":
      return "Technical Skills";
    case "projects":
      return "Projects";
    case "certifications":
      return "Certifications";
    case "publications":
      return "Publications";
    case "awards":
      return "Awards";
    case "image_ocr":
      return "OCR";
    default:
      return "Other";
  }
}

function chunkSection(
  section: ParsedSection,
  cvId: string,
  userId: string,
  genId: () => string,
  sourceImageUrl: string | null,
): CvChunk[] {
  const label = composeLabel(section);
  const body = section.body.trim();

  // Empty section? Emit a single placeholder chunk so the user can
  // see "Skills (empty)" in the chunk inspector and add content.
  if (body.length === 0) {
    return [
      {
        id: genId(),
        cvId,
        userId,
        section: section.kind,
        sectionLabel: label,
        content: "",
        ordinality: 0,
        tokenCount: 0,
        sourceImageUrl,
        structuredPayload: null,
      },
    ];
  }

  // Table-shaped section: one chunk, structured payload populated.
  if (section.hasTable) {
    const rows = tableRows(body);
    return [
      {
        id: genId(),
        cvId,
        userId,
        section: section.kind,
        sectionLabel: label,
        content: body,
        ordinality: 0,
        tokenCount: estimateTokens(body),
        sourceImageUrl,
        structuredPayload: rows ? { kind: "table", rows } : null,
      },
    ];
  }

  // Prose: split into overlapping windows.
  const windows = splitByTokens(body, TARGET_TOKENS, OVERLAP_TOKENS);
  return windows.map((w, i) => ({
    id: genId(),
    cvId,
    userId,
    section: section.kind,
    sectionLabel: i === 0 ? label : `${label} (cont.)`,
    content: w,
    ordinality: i,
    tokenCount: estimateTokens(w),
    sourceImageUrl,
    structuredPayload: null,
  }));
}

// ---------- Public entry point ----------

/**
 * Chunk a parsed CV. The ingester (Phase 4) calls this with a fresh
 * `genId` that produces stable UUIDs so we can upsert deterministically
 * when a CV is re-uploaded.
 *
 * @param parsed   The parser output.
 * @param meta     The `cvId` and `userId` to stamp on every chunk.
 * @param genId    A function that returns a fresh UUID. The ingester
 *                 uses `crypto.randomUUID`; tests can pass a counter.
 */
export function chunkCv(
  parsed: ParserOutput,
  meta: { cvId: string; userId: string },
  genId: () => string,
): CvChunk[] {
  if (parsed.needsOcr) {
    // The OCR pipeline will run separately and produce its own
    // chunks with `section = 'image_ocr'`. We emit zero here.
    return [];
  }
  if (parsed.sections.length === 0) {
    // No headers detected — fall back to one big "other" section
    // over the whole raw text. The chunker's overlap splitter
    // handles arbitrarily long input.
    const fallback: ParsedSection = {
      kind: "other",
      label: "",
      header: "",
      body: parsed.rawText,
      startLine: 0,
      endLine: parsed.rawText.split("\n").length,
      hasTable: false,
    };
    return chunkSection(fallback, meta.cvId, meta.userId, genId, null);
  }

  const out: CvChunk[] = [];
  for (const s of parsed.sections) {
    // If the parser saw page-image metadata in the future, we'd
    // resolve it per-section. For v1 we have no page boundaries
    // for DOCX, and the page images for PDFs are uploaded with a
    // 1:1 chunk mapping later — leaving sourceImageUrl null here
    // is safe; the ingester can backfill it after rendering.
    out.push(...chunkSection(s, meta.cvId, meta.userId, genId, null));
  }
  return out;
}
