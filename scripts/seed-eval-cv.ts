/**
 * Seed a synthetic CV for the eval user.
 *
 * Why this exists
 * ---------------
 * The eval suite (`evals/run.ts`) talks to the running dev server as
 * `user_eval_demo` (or whatever EVAL_USER_ID is set to). For the
 * `fit-score` and `specialised assistant` cases to produce meaningful
 * output, that user must have an `is_active = true` CV in the
 * `public.cvs` table with `cv_chunks` populated and embedded. The
 * real CV upload flow goes through `POST /api/cv/upload`, but that
 * requires multipart form-data and a file on disk; for an automated
 * one-shot we can hit the same primitives the upload route uses.
 *
 * What this does
 * --------------
 *  1. Build a synthetic CV text that covers the `frontend-engineer`
 *     benchmark's must-haves (TypeScript, React, Next.js, CSS,
 *     Tailwind, semantic HTML, JavaScript, Git) and several
 *     nice-to-haves (accessibility, testing, design systems,
 *     performance, Node.js). This is what makes the
 *     `fit_score.strong_match` case pass (score ≥ 70).
 *  2. Insert a `cvs` row for the eval user with `is_active = true`
 *     and `status = 'ready'`.
 *  3. Chunk the text with the same `chunkCv` the ingester uses, so
 *     the section breakdown matches what a real upload would produce.
 *  4. Embed each chunk with `embedBatch` (Gemini 3072-dim) and
 *     persist via the `replace_cv_chunks` RPC — the same call the
 *     upload route makes on success.
 *
 * Idempotency
 * -----------
 *  - Wipes any pre-existing `cvs` for the user before inserting.
 *    `replace_cv_chunks` deletes-and-reinserts per section, so
 *    re-running this script on a fresh DB is a clean state.
 *  - Safe to re-run while the dev server is up; the next eval run
 *    will pick up the new chunks.
 *
 * Usage
 * -----
 *   npx tsx scripts/seed-eval-cv.ts
 *   EVAL_USER_ID=user_abc123 npx tsx scripts/seed-eval-cv.ts
 *
 * Requires
 * --------
 *   - GEMINI_API_KEY in .env.local (or env) for embeddings.
 *   - SUPABASE_SERVICE_ROLE_KEY in .env.local for the admin client.
 */

// Node 22+ supports --env-file. Run with:
//   npx tsx --env-file=.env.local scripts/seed-eval-cv.ts
// (dotenv was the old approach, but ESM hoists imports above the
// config() call, so `supabaseAdmin` was reading undefined envs.)
import { supabaseAdmin } from "@/lib/supabase/admin";
import { chunkCv } from "@/lib/cv/chunk";
import { embedBatch } from "@/lib/ai/embeddings";

const EVAL_USER_ID = process.env.EVAL_USER_ID ?? "user_eval_demo";

/**
 * Synthetic CV that hits the `frontend-engineer` must-have set.
 * Written as plain text so the chunker recognises section headings
 * (Summary, Experience, Skills, etc.) and emits roughly the same
 * shape a real DOCX would.
 */
const SYNTHETIC_CV_TEXT = `Alex J. Park
Frontend Engineer  ·  Toronto, ON  ·  alex.park@example.com  ·  linkedin.com/in/alexparkfe  ·  github.com/alexparkfe

PROFESSIONAL SUMMARY

Frontend Engineer with 5+ years of experience shipping production React and Next.js applications. Strong background in TypeScript, modern CSS (Flexbox, Grid, custom properties), and Tailwind. Care deeply about web accessibility (WCAG 2.1 AA), Core Web Vitals, and design systems. Comfortable owning a feature from Figma through to a green CI deploy.

TECHNICAL SKILLS

Languages: JavaScript (ES2022+), TypeScript, HTML, Semantic HTML, CSS (modern CSS3, Flexbox, Grid)
Frameworks: React, Next.js (App Router, RSC), Tailwind CSS, Node.js
Tooling: Git, GitHub Actions, Vite, Vitest, Playwright, Storybook
Quality: Web Accessibility (a11y, WCAG, ARIA), Testing (Jest, Playwright, Vitest), Web Performance (Core Web Vitals, Lighthouse), Design Systems (Storybook, Figma)
Other: GraphQL, REST, Figma, Sentry

PROFESSIONAL EXPERIENCE

Senior Frontend Engineer  |  Lumen Health  ·  Toronto, ON  ·  Mar 2023 - Present

Lead engineer on the patient portal rebuild, migrating a legacy AngularJS app to Next.js (App Router) and TypeScript. Set up the new design system in Storybook with 60+ components, used by four product teams. Owned the Web Vitals dashboard: cut LCP from 3.4s to 1.6s and reduced CLS to 0.02 by deferring third-party scripts and shipping critical CSS. Introduced a Playwright + Vitest testing pyramid that took coverage from 28% to 78%. Mentored two junior engineers through structured 1-on-1s and code review.

Frontend Engineer  |  Northwind Retail  ·  Toronto, ON  ·  Jun 2021 - Feb 2023

Shipped the new checkout flow in React + TypeScript with a Tailwind-based design system; conversion rate up 12%. Built a GraphQL BFF with Node.js that aggregated inventory, pricing, and review services, trimming average p95 page time from 1.4s to 480ms. Owned the accessibility remediation backlog (150+ WCAG issues closed), passing a third-party audit with zero critical findings. Wrote the team's frontend style guide (naming, file layout, review checklist) and ran monthly knowledge shares.

Frontend Developer  ·  Cobalt Studio  ·  Toronto, ON  ·  Aug 2019 - May 2021

Built marketing sites and product UIs for B2B SaaS clients in Next.js, TypeScript, and Tailwind. Implemented a reusable component library in Storybook adopted across three client projects. Reduced JS bundle size by 38% via route-level code splitting and dynamic imports. Wrote Playwright smoke tests for the agency's top-five templates.

EDUCATION

B.Sc. Computer Science  |  University of Toronto  ·  2015 - 2019  ·  Toronto, ON

CERTIFICATIONS & SPEAKING

Accessibility Specialist (IAAP WAS) - 2024
Speaker: ReactConf 2023 - "Server Components in the Wild: a Migration Diary"
`;

interface RpcChunkPayload {
  section: string;
  section_label: string;
  content: string;
  embedding: string; // stringified number[] → cast to vector(3072) in the RPC
  ordinality: number;
  token_count: number;
  edited_at: string;
}

async function main() {
  console.log(`▶ Seeding CV for user_id=${EVAL_USER_ID}`);

  // 0. Sanity: required env vars present.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in .env.local");
  }
  if (!process.env.GEMINI_API_KEY && !process.env.Gemini_API_Key) {
    throw new Error("Missing GEMINI_API_KEY in .env.local");
  }

  // 1. Wipe any existing CVs for this user (FK cascades to cv_chunks).
  const { error: delError } = await supabaseAdmin
    .from("cvs")
    .delete()
    .eq("user_id", EVAL_USER_ID);
  if (delError) {
    throw new Error(`Failed to wipe existing CVs: ${delError.message}`);
  }
  console.log("  · Cleared any pre-existing CVs for this user.");

  // 2. Insert the new active CV row.
  const { data: cvRow, error: cvInsertError } = await supabaseAdmin
    .from("cvs")
    .insert({
      user_id: EVAL_USER_ID,
      name: "Alex Park - Frontend Engineer (eval seed)",
      file_url: null,
      source: "builder",
      raw_text: SYNTHETIC_CV_TEXT,
      section_index: null,
      page_images: null,
      needs_ocr: false,
      is_active: true,
      status: "ready",
      error_message: null,
    })
    .select("id")
    .single();

  if (cvInsertError || !cvRow) {
    throw new Error(`Failed to create cvs row: ${cvInsertError?.message ?? "unknown"}`);
  }
  const cvId = cvRow.id as string;
  console.log(`  · Inserted cvs row id=${cvId} (is_active=true, status=ready).`);

  // 3. Chunk the text via the same helper the upload route uses.
  const chunks = chunkCv(SYNTHETIC_CV_TEXT, { cvName: "Alex Park" });
  if (chunks.length === 0) {
    throw new Error("chunkCv produced 0 chunks — text was not parseable.");
  }
  console.log(`  · chunkCv produced ${chunks.length} chunks.`);

  // 4. Embed all chunks in one batched Gemini call.
  const inputs = chunks.map((c) => `${c.section_label}\n${c.content}`);
  const vectors = await embedBatch(inputs);
  if (vectors.length !== chunks.length) {
    throw new Error(
      `embedBatch returned ${vectors.length} vectors for ${chunks.length} chunks`,
    );
  }
  console.log(`  · Embedded ${vectors.length} chunks (dim=${vectors[0]?.length ?? 0}).`);

  // 5. Persist via replace_cv_chunks RPC.
  const sections = Array.from(new Set(chunks.map((c) => c.section)));
  const nowIso = new Date().toISOString();
  const rpcPayload: RpcChunkPayload[] = chunks.map((c, i) => {
    const vector = vectors[i];
    if (!vector) throw new Error(`Missing vector for chunk ${i}`);
    return {
      section: c.section,
      section_label: c.section_label,
      content: c.content,
      embedding: JSON.stringify(vector),
      ordinality: c.ordinality,
      token_count: c.token_count,
      edited_at: nowIso,
    };
  });

  const { data: insertedCount, error: rpcError } = await supabaseAdmin.rpc(
    "replace_cv_chunks",
    {
      p_cv_id: cvId,
      p_sections: sections,
      p_chunks: rpcPayload as unknown as Record<string, unknown>,
    },
  );

  if (rpcError) {
    throw new Error(`replace_cv_chunks RPC failed: ${rpcError.message}`);
  }
  console.log(`  · replace_cv_chunks inserted ${insertedCount} rows.`);

  console.log("\n✅ Seed complete.");
  console.log(`   - cvs.id       = ${cvId}`);
  console.log(`   - chunks       = ${chunks.length}`);
  console.log(`   - sections     = ${sections.join(", ")}`);
  console.log(`   - user_id      = ${EVAL_USER_ID}`);
  console.log("\nNext: `npm run evals` should now find a strong match for");
  console.log("`frontend-engineer` and weak match for `data-engineer`.");
}

main().catch((err) => {
  console.error("\n❌ Seed failed:", err);
  process.exit(1);
});
