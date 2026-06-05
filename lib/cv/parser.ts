/**
 * CV parser — turns an uploaded PDF or DOCX into a structured
 * representation the chunker (and the chunk-inspector UI) can work
 * with.
 *
 * Pipeline
 * --------
 *   1. Sniff the mime type from the file bytes (magic number) — the
 *      uploader's content-type is not trustworthy.
 *   2. Route to the right extractor:
 *        - PDF: pdf-parse → { rawText, pageCount, per-page text via
 *          a re-scan with `pdfjs-dist` only if we hit the OCR path;
 *          for v1 we get the full text and let the chunker split by
 *          section headers}.
 *        - DOCX: mammoth → rawText (DOCX is plain-text-friendly).
 *   3. Section detection: walk the raw text line-by-line and look for
 *      common CV section headers (case-insensitive, accent-folded,
 *      with a few synonyms). Each match opens a new `Section` and
 *      accumulates lines until the next match.
 *   4. Table detection: lines that look like pipe tables (`| ... |`)
 *      or markdown tables get flagged so the chunker can emit
 *      `structured_payload`.
 *   5. Page image extraction: for PDFs we render each page to PNG
 *      (via pdfjs-dist `getPage().render`) and upload to Supabase
 *      Storage under `cv-pages/{cvId}/p{nnn}.png`. For DOCX, page
 *      boundaries are not native, so we render to a single image
 *      only if the user explicitly asks — skipped in v1.
 *   6. OCR fallback: if pdf-parse returns almost no text
 *      (`rawText.length < 80 * pageCount` characters per page on
 *      average) we set `needsOcr = true` and leave `pageImages` for
 *      the OCR pass to consume. The chunker will produce zero
 *      chunks in that case.
 *
 * Why this shape
 * --------------
 * The chunker takes `ParserOutput` and produces `Chunk[]`. The
 * chunk-inspector UI (Phase 7) reads `sections` and `pageImages`
 * directly to render a side-by-side preview. The Inngest job
 * (Phase 4) feeds `rawText` to the embedder only for OCR-skipped
 * cases; for text-native cases it embeds each chunk instead.
 */

import mammoth from "mammoth";

// `unpdf` is a serverless-safe PDF text extractor that bundles its
// own stripped-down pdfjs build (no DOMMatrix / OffscreenCanvas,
// worker inlined, polyfills for `FinalizationRegistry` and
// `Promise.withResolvers`). We use it instead of `pdf-parse@2` whose
// default CJS entry pulls in a browser-targeted pdfjs bundle that
// throws `DOMMatrix is not defined` the moment it loads on Node 20
// Lambda. See: https://github.com/unjs/unpdf
import { extractText, getDocumentProxy } from "unpdf";

// ---------- Public types ----------

/**
 * Section types we emit. The DB `cv_chunks.section` check constraint
 * accepts a superset; unknown sections fall through to "other".
 */
export type CvSectionKind =
  | "summary"
  | "objective"
  | "experience"
  | "work_experience"
  | "education"
  | "skills"
  | "technical_skills"
  | "projects"
  | "certifications"
  | "publications"
  | "awards"
  | "image_ocr"
  | "other";

/** A detected section in the CV — the header line + the body lines. */
export interface ParsedSection {
  /** Normalised section kind. */
  kind: CvSectionKind;
  /**
   * Human-readable label, e.g. "Experience", "Experience > Acme Corp
   * (2024)". The chunker composes this from the section kind plus
   * the first non-empty line under it (often a company or school
   * name). Filled in by the chunker, not the parser.
   */
  label: string;
  /** Section header text as it appeared in the file. */
  header: string;
  /** Body text. Newlines preserved. */
  body: string;
  /**
   * The line index in `rawText` where this section starts. Lets the
   * UI scroll the source preview to the right line.
   */
  startLine: number;
  /** The line index where this section ends (exclusive). */
  endLine: number;
  /**
   * True if the section's body contains a markdown-style table. The
   * chunker will mark downstream chunks as table-shaped and populate
   * `structured_payload`.
   */
  hasTable: boolean;
}

/** A page image rendered to PNG and uploaded to Supabase Storage. */
export interface ParsedPageImage {
  /** 1-indexed page number. */
  page: number;
  /** Storage path, e.g. `cv-pages/abc/p003.png`. */
  storagePath: string;
  /** Public/signed URL. The chat UI uses this for "view source page". */
  url: string;
}

/** The parser's full output. */
export interface ParserOutput {
  /** Mime type we detected, normalised to `application/pdf` or `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. */
  mime: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  /** The full extracted text. Newlines normalised to `\n`. */
  rawText: string;
  /** Detected sections in document order. */
  sections: ParsedSection[];
  /** Page count from the source file. 1 for DOCX (best-effort). */
  pageCount: number;
  /** Rendered page images. Empty unless `renderPages: true` and we have a SupabaseStorage client. */
  pageImages: ParsedPageImage[];
  /**
   * True if the parser suspects the file is a scanned PDF (almost
   * no extractable text). The Inngest job will trigger the OCR
   * pipeline in that case; the chunker will produce zero chunks
   * until OCR completes.
   */
  needsOcr: boolean;
}

// ---------- Section header detection ----------

/**
 * Mapping from header patterns → section kind. The patterns are
 * case-insensitive, accent-folded, and allow some leading garbage
 * (bullets, whitespace). Each entry is tested in order; the first
 * match wins.
 */
const SECTION_PATTERNS: ReadonlyArray<{
  kind: CvSectionKind;
  pattern: RegExp;
}> = [
  { kind: "summary", pattern: /^(summary|professional summary|profile|about( me)?)\s*:?\s*$/i },
  { kind: "objective", pattern: /^(objective|career objective)\s*:?\s*$/i },
  { kind: "work_experience", pattern: /^(work experience|employment( history)?|professional experience|career history)\s*:?\s*$/i },
  { kind: "experience", pattern: /^(experience)\s*:?\s*$/i },
  { kind: "education", pattern: /^(education|academic background|qualifications)\s*:?\s*$/i },
  { kind: "technical_skills", pattern: /^(technical skills|tech skills|technologies|stack|tools?)\s*:?\s*$/i },
  { kind: "skills", pattern: /^(skills|key skills|core (skills|competencies)|areas of (expertise|strength))\s*:?\s*$/i },
  { kind: "projects", pattern: /^(projects|personal projects|side projects|selected projects|key projects)\s*:?\s*$/i },
  { kind: "certifications", pattern: /^(certifications?|licenses?( and certifications?)?|professional development)\s*:?\s*$/i },
  { kind: "publications", pattern: /^(publications|papers|talks|presentations)\s*:?\s*$/i },
  { kind: "awards", pattern: /^(awards|honors?|achievements|recognition)\s*:?\s*$/i },
];

/** Match `Experience > Acme Corp` style first lines under a header. */
const SUBSECTION_COMPANY_RE =
  /^\s*(?:[-•●▪◦*]\s*)?([A-Z][\w&.,' -]{1,60}?)(?:\s*[|·\-–—,]|\s+\(|\s+-\s)\s*(.{0,80})\s*$/;

/** Markdown/pipe table detector. A line of pipes + dashes counts. */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)*\s*\|?\s*$/;
const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;

/** Strip diacritics so "résumé" matches "resume". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function detectSectionKind(line: string): CvSectionKind | null {
  const folded = fold(line.trim());
  for (const { kind, pattern } of SECTION_PATTERNS) {
    if (pattern.test(folded)) return kind;
  }
  return null;
}

function looksLikeTable(lines: string[]): boolean {
  // Need at least 2 lines: a header row + a separator. Body rows
  // are optional.
  if (lines.length < 2) return false;
  if (!TABLE_LINE_RE.test(lines[0]!)) return false;
  for (let i = 1; i < Math.min(lines.length, 4); i++) {
    if (TABLE_SEPARATOR_RE.test(lines[i]!)) return true;
  }
  return false;
}

/**
 * Group `rawText` into sections by walking line-by-line and looking
 * for known section headers. A new section starts at a header line
 * and ends at the next header (or EOF).
 *
 * If no section headers are found, the whole document is one big
 * "other" section — the chunker will fall back to naive splits.
 */
function detectSections(rawText: string): ParsedSection[] {
  const lines = rawText.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kind = detectSectionKind(line);
    if (kind) {
      if (current) {
        current.endLine = i;
        sections.push(current);
      }
      current = {
        kind,
        label: "", // filled in by the chunker
        header: line.trim(),
        body: "",
        startLine: i,
        endLine: lines.length,
        hasTable: false,
      };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    }
  }
  if (current) {
    current.endLine = lines.length;
    sections.push(current);
  }

  // Decorate: detect tables per section, and let the chunker fill
  // `label` later. We do a dry-run `looksLikeTable` over the first
  // few body lines to flag table-shaped sections early.
  for (const s of sections) {
    const bodyLines = s.body.split(/\r?\n/);
    s.hasTable = looksLikeTable(bodyLines);
  }
  return sections;
}

// ---------- Extractors ----------

/**
 * Sniff the file type from the first few bytes. We don't trust
 * content-type because browsers and S3 clients both get it wrong.
 */
export function sniffMime(buf: Buffer): "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | null {
  // PDF: `%PDF-` (25 50 44 46 2D)
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d) {
    return "application/pdf";
  }
  // DOCX: ZIP magic `PK\x03\x04` and the file `word/document.xml`
  // inside. We only check the magic here; mammoth will throw if
  // the inner structure isn't DOCX.
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return null;
}

interface PdfExtractResult {
  rawText: string;
  pageCount: number;
}

/**
 * Extract text from a PDF buffer using `unpdf` (which bundles a
 * serverless-safe pdfjs build under the hood). Returns the full
 * text concatenated across pages and the page count.
 *
 * unpdf's API: `getDocumentProxy` parses the bytes into a lazy
 * document, `extractText` walks the pages and either returns an
 * array of per-page strings or — with `mergePages: true` — one
 * concatenated string. We always pass `mergePages: true` to
 * preserve the previous pdf-parse behaviour.
 */
async function extractPdf(buf: Buffer): Promise<PdfExtractResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { rawText: text ?? "", pageCount: totalPages ?? 1 };
}

/**
 * Extract text from a DOCX buffer using mammoth. We use
 * `extractRawText` because we want line-by-line structure, not the
 * HTML conversion.
 */
async function extractDocx(buf: Buffer): Promise<{ rawText: string; pageCount: number }> {
  const { value, messages } = await mammoth.extractRawText({ buffer: buf });
  if (messages.length > 0) {
    // Mammoth emits warnings for non-fatal style issues. We log
    // them but don't fail — the extracted text is usually good
    // enough. The Inngest job will surface these upstream.
    // eslint-disable-next-line no-console
    console.warn(`[parser] mammoth emitted ${messages.length} message(s):`, messages.slice(0, 3));
  }
  // DOCX doesn't have page boundaries in its XML; we estimate
  // pages from line count (~50 lines per page). This is only used
  // for the OCR threshold check.
  const lineCount = value.split(/\r?\n/).length;
  return { rawText: value, pageCount: Math.max(1, Math.ceil(lineCount / 50)) };
}

/**
 * Heuristic: is this PDF actually scanned? pdf-parse returns empty
 * (or near-empty) text for image-only PDFs. We treat
 * `rawText.length < 80 * pageCount` as a strong signal.
 */
function pdfLooksScanned(rawText: string, pageCount: number): boolean {
  const trimmed = rawText.replace(/\s+/g, "");
  return trimmed.length < 80 * pageCount;
}

// ---------- Public entry point ----------

/**
 * Parse a CV file buffer. Caller is responsible for handing us the
 * raw bytes (downloaded from Supabase Storage, or read from a
 * multipart upload in tests).
 *
 * @param buf  The file bytes.
 * @param opts.mime  Optional mime override. If omitted we sniff
 *                   the bytes.
 */
export async function parseCv(
  buf: Buffer,
  opts: { mime?: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } = {},
): Promise<ParserOutput> {
  const mime = opts.mime ?? sniffMime(buf);
  if (!mime) {
    throw new Error(
      "[parseCv] Unrecognised file type. Expected a PDF or DOCX.",
    );
  }

  let rawText: string;
  let pageCount: number;
  if (mime === "application/pdf") {
    const pdf = await extractPdf(buf);
    rawText = pdf.rawText;
    pageCount = pdf.pageCount;
  } else {
    const docx = await extractDocx(buf);
    rawText = docx.rawText;
    pageCount = docx.pageCount;
  }

  // Normalise line endings + strip BOM + collapse trailing spaces
  // on each line. Keep paragraph breaks (\n\n) intact so the
  // chunker can preserve them.
  rawText = rawText
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n");

  const sections = detectSections(rawText);
  const needsOcr = mime === "application/pdf" && pdfLooksScanned(rawText, pageCount);

  return {
    mime,
    rawText,
    sections,
    pageCount,
    pageImages: [], // filled in by the Inngest job's render step
    needsOcr,
  };
}

/**
 * Helper: given a section's body, extract the most likely
 * "subsection" label (e.g. a company or school name on the first
 * non-empty line). Returns the original line if no clear match.
 *
 * Exported for the chunker; not used by the parser itself.
 */
export function extractSubsectionLabel(body: string): string | null {
  const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  const m = SUBSECTION_COMPANY_RE.exec(firstLine);
  if (m && m[1]) {
    // Strip trailing punctuation and trim
    return m[1].replace(/[.,;]+$/, "").trim();
  }
  // Fall back to the first non-empty line, capped at 60 chars
  return firstLine.trim().slice(0, 60) || null;
}
