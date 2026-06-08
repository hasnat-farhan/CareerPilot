#!/usr/bin/env node
// scripts/make-warmup-pdf.mjs
// One-shot generator for public/warmup.pdf. A minimal valid 1-page PDF
// that pdf-parse v2 can extract one line of text from. The text content
// doesn't matter — the chunker will drop anything under MIN_CONTENT_CHARS
// (30) and the warmup row is deleted after ingest regardless. We give it
// just enough text to produce 0–1 chunks (the warmup is happy with 0
// chunks, but `replace_cv_chunks` with an empty array is still cleaner
// than fighting edge cases in the embedder).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "public", "warmup.pdf");
mkdirSync(dirname(outPath), { recursive: true });

// Minimal hand-rolled PDF. We build the byte stream, then walk it to
// fill in the cross-reference table (`xref`) offsets correctly.
const lines = [
  "%PDF-1.4",
  "%\u00E2\u00E3\u00CF\u00D3", // binary marker so tools don't rewrite the file
];

const objects = [
  // 1: Catalog
  "<< /Type /Catalog /Pages 2 0 R >>",
  // 2: Pages
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  // 3: Page
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  // 4: Font
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  // 5: Content stream (one line of text on the page)
  "<< /Length 86 >>\nstream\nBT /F1 12 Tf 72 720 Td (CareerPilot warmup placeholder CV) Tj ET\nendstream",
];

// Record xref offsets for each object.
const xref = [];
let body = "";
for (let i = 0; i < objects.length; i++) {
  xref.push(lines.join("\n").length + 1 + body.length);
  body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}

const xrefStart = lines.join("\n").length + 1 + body.length;
let xrefTable = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of xref) {
  xrefTable += `${String(off).padStart(10, "0")} 00000 n \n`;
}

const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

const full = lines.join("\n") + "\n" + body + xrefTable + trailer;
writeFileSync(outPath, full, "binary");
console.log(`Wrote ${outPath} (${full.length} bytes)`);
