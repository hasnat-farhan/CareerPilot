import { getDocumentProxy, extractText } from "unpdf";
import mammoth from "mammoth";

/**
 * Parse a CV file (PDF or DOCX) into raw plain text.
 *
 * - PDF:  `unpdf` (serverless-safe pdfjs build — no `DOMMatrix`,
 *         no OffscreenCanvas, worker inlined). `mergePages: true`
 *         collapses the per-page arrays into a single string.
 * - DOCX: `mammoth.extractRawText` → plain text. DOCX is a ZIP of
 *         XML, so the result is already UTF-8.
 *
 * Throws on:
 *   - Unknown extension
 *   - Malformed PDF/DOCX bytes
 *   - Empty buffer
 */
export async function parseCv(buffer: Buffer, filename: string): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase();

  if (ext === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }

  if (ext === "docx") {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  throw new Error(`Unsupported file type: ${ext ?? "(none)"}`);
}
