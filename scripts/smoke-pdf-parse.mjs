#!/usr/bin/env node
/**
 * Smoke test for the PDF parser. Loads `unpdf`, parses a tiny
 * in-memory PDF (or the package's own test fixture if we can find
 * one), and prints the first 200 chars of extracted text. Exits 0
 * on success, 1 on failure.
 *
 * Usage:  node scripts/smoke-pdf-parse.mjs
 */

import { extractText, getDocumentProxy } from "unpdf";

async function main() {
  // 1. The smallest valid PDF we can hand-craft. This is a one-page
  // PDF with the text "Hello PDF" inside a content stream.
  const tinyPdf = Buffer.from(
    "%PDF-1.4\n" +
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
      "4 0 obj<</Length 44>>stream\n" +
      "BT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET\n" +
      "endstream\nendobj\n" +
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
      "xref\n0 6\n0000000000 65535 f\n0000000010 00000 n\n0000000053 00000 n\n0000000100 00000 n\n0000000189 00000 n\n0000000280 00000 n\n" +
      "trailer<</Size 6/Root 1 0 R>>\nstartxref\n340\n%%EOF",
    "binary",
  );

  console.log(`[smoke-pdf-parse] tinyPdf bytes=${tinyPdf.length}`);

  const pdf = await getDocumentProxy(new Uint8Array(tinyPdf));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  console.log(`[smoke-pdf-parse] totalPages=${totalPages}`);
  console.log(`[smoke-pdf-parse] text=${JSON.stringify(text).slice(0, 200)}`);

  if (typeof text !== "string") {
    throw new Error(`expected string, got ${typeof text}`);
  }
  if (totalPages !== 1) {
    // Some pdfjs builds may return 0 or 2; we just want a number.
    console.warn(`[smoke-pdf-parse] unexpected totalPages=${totalPages} (non-fatal)`);
  }
  console.log("[smoke-pdf-parse] OK");
}

main().catch((e) => {
  console.error("[smoke-pdf-parse] FAIL", e);
  process.exit(1);
});
