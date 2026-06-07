import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

/**
 * Parse a CV file (PDF or DOCX) into raw plain text.
 *
 * - PDF:  `pdf-parse` v2 (the `PDFParse` class). We use this in
 *         preference to `unpdf`/`pdfjs` for one specific reason:
 *         pdf-parse preserves the line breaks that the PDF's text
 *         drawing operators emit, so headers like "Education" stay
 *         on their own line. `unpdf`'s `mergePages` join collapses
 *         those line breaks, which left the chunker with a single
 *         long string and no detectable section boundaries.
 *         (This module is `runtime = "nodejs"`, so the v2 class
 *         which uses pdfjs under the hood is fine — see
 *         `next.config.ts`.)
 * - DOCX: `mammoth.extractRawText` → plain text. DOCX is a ZIP of
 *         XML, so the result is already UTF-8.
 *
 * Throws on:
 *   - Unknown extension
 *   - Malformed PDF/DOCX bytes
 *   - Empty buffer
 */

// pdf-parse v2 uses pdfjs-dist under the hood. In Node.js, pdfjs's
// fake-worker bootstrap still tries to `import(this.workerSrc)` and
// throws "Setting up fake worker failed: Cannot find module
// './pdf.worker.mjs'" if workerSrc is left as its relative default —
// because in a Next.js server bundle there is no `pdf.worker.mjs`
// sitting next to the chunk. We resolve the worker file from the
// installed `pdfjs-dist` package and point pdfjs at it via a
// `file://` URL. This is the supported setup; pdfjs then runs the
// worker module on the main thread (it's all in the same Node
// process anyway, so there's no perf cost for a one-shot CV parse).
//
// We do this lazily on the first call rather than at module-import
// time, because (a) we want to avoid the resolution cost in any
// route that imports `parseCv` but never parses a PDF, and (b) we
// also need the `pdf-parse` ESM module to be loaded by the time
// `PDFParse.setWorker` is invoked, which only happens once the class
// has been imported and used at least once.
let workerConfigured = false;
function ensureWorkerConfigured(): void {
  if (workerConfigured) return;
  // Build the worker subpath from string segments instead of writing
  // it as a literal, so webpack/Turbopack can't see the
  // `pdfjs-dist/legacy/build/pdf.worker.mjs` substring in the source
  // and try to bundle/resolve it at build time. At runtime the
  // result is identical.
  const pkg = ["pdfjs", "dist"].join("-");
  const workerSubpath = ["legacy", "build", "pdf.worker.mjs"].join("/");
  const workerSpec = `${pkg}/${workerSubpath}`;
  // `createRequire` lets us resolve through the package's own
  // `node_modules` graph, which is the most reliable way to find
  // the worker file from an ESM context (and survives Next's
  // bundling, since the literal `workerSpec` is never visible to
  // the static analyzer).
  const requireFromHere = createRequire(import.meta.url);
  let workerPath: string;
  try {
    workerPath = requireFromHere.resolve(workerSpec);
  } catch {
    // Fallback for CJS contexts (no `import.meta.url`).
    workerPath = require.resolve(workerSpec);
  }
  const workerUrl = pathToFileURL(workerPath).href;
  PDFParse.setWorker(workerUrl);
  workerConfigured = true;
}

export async function parseCv(buffer: Buffer, filename: string): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase();

  if (ext === "pdf") {
    ensureWorkerConfigured();
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  if (ext === "docx") {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  throw new Error(`Unsupported file type: ${ext ?? "(none)"}`);
}
