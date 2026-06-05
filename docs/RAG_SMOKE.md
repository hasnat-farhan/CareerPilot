# Pillar 2 — Profile & Resume Intelligence

This document covers everything built for **Pillar 2 (RAG Core)** in
CareerPilot: the schema, the parsing/ingestion pipeline, the API surface,
and the CV management UI.

For the **wiring smoke test** (hermetic, runs in 1 second, no network) see
`scripts/smoke-rag.mjs`. For the **manual end-to-end test** follow the
checklist at the bottom of this file.

## What was built

### 1. Data model

Two tables (with a third partial unique index):

| Table        | Purpose                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `cvs`        | One row per uploaded CV: storage path, parser status, version, active flag, name. |
| `cv_chunks`  | Section-aware text chunks with 3072-dim embeddings for cosine retrieval. |
| `match_cv_chunks` RPC | The single SQL entry point that takes a query embedding + user_id and returns the top-k matching chunks for the user's currently-active CV. |

A **partial unique index** `cvs_one_active_per_user` enforces that at most
one `cvs` row per `user_id` has `is_active = true` at the DB level. The
PATCH route handles the toggle safely by demoting the prior active row
before promoting a new one.

Migrations (apply in order):

- `20260605_chat_history.sql`           — thread/message tables
- `20260605_chat_assistant_mode.sql`    — `mode` + `structured_result` columns
- `20260605_cv.sql`                     — `cvs`, `cv_chunks`, `match_cv_chunks` RPC
- `20260605_fit_scores.sql`             — fit-score cache
- `20260605_hunter.sql`                 — hunter cache
- `20260606_cv_name.sql`                — `cvs.name` column + trgm index

### 2. Ingestion pipeline

`lib/cv/parser.ts` extracts text from PDF (`pdf-parse`) and DOCX
(`mammoth`). For PDFs with no extractable text (scanned images) it
returns a `needs_ocr` signal so the API can surface a clear error rather
than silently producing empty chunks.

`lib/cv/chunker.ts` splits the document into section-aware chunks. Each
chunk carries:

- `section`        — `summary | experience | education | skills | projects | other`
- `section_label`  — human label, e.g. `Experience > Acme Corp (2024)`
- `ordinality`     — position in the document
- `token_count`    — used for the chunk inspector UI
- `embedding`      — 3072-dim Gemini embedding, stored as a `vector(3072)`

`lib/cv/ingester.ts` is the background worker that parses, chunks,
embeds, and writes to `cv_chunks` in one transaction. It updates the
parent `cvs` row's `status` from `processing` → `ready` (or `failed` with
`error_message`).

### 3. API surface

| Method | Path                          | Purpose                                       |
| ------ | ----------------------------- | --------------------------------------------- |
| POST   | `/api/cv/upload`              | Upload a PDF/DOCX. Returns the new CV id. Ingestion runs in the background. |
| GET    | `/api/cv`                     | List the caller's CVs with chunk counts.      |
| GET    | `/api/cv/[id]`                | CV detail + first 5 chunk previews.           |
| PATCH  | `/api/cv/[id]`                | Rename and/or set active.                     |
| DELETE | `/api/cv/[id]`                | Delete chunks → row → storage (soft-fails storage). |

All routes are `runtime = "nodejs"` (the parser is CJS-only), use
`requireUserId()` for Clerk auth, and filter by `user_id` explicitly as
defence in depth on top of RLS.

### 4. RAG seam

`lib/rag/retrieve-cv.ts` is the **single** retrieval function used by
the chat, hunter, and fit-score agents. The signature is:

```ts
retrieveCvChunks(userId: string, query: string): Promise<Citation[]>
```

The `Citation` shape is the **stable contract** between the server and
the chat UI. It carries `id`, `source`, `text`, `score`, `section`, and
`sourceImageUrl` so the UI can render the citation body, a "view source
page" link, and the inline `[chunk-id]` references the assistant
produces.

The retriever returns `[]` (not an error) when the user has no active
CV yet. The agents tolerate this.

### 5. Chat wiring

`app/api/chat/threads/[id]/messages/route.ts` is the only place that
calls the assistant router. It:

1. Resolves the Clerk user.
2. Validates thread ownership.
3. Persists the user message.
4. Loads history.
5. Calls `runAssistant(input, retrieveCvChunks)`.
6. Extracts `citations` **only** from general mode (specialised modes
   already include their own structured payload).
7. Persists the assistant reply with `mode`, `citations`, and
   `structured_result`.
8. Auto-titles the thread on the first exchange.

The chat UI renders the citations inline in the assistant bubble,
matching the `[chunk-id]` markers the general-mode prompt asks the
model to emit.

### 6. CV management UI

`app/(dashboard)/cv/page.tsx` is a single client component (no extra
files) that:

- Has a drag-and-drop upload card with inline validation (PDF/DOCX,
  ≤ 20 MB) and friendly error/success banners.
- Lists every CV with status pills (ready / processing / failed),
  chunk count, version, and uploaded time.
- Lets you **rename** inline (Enter commits, Escape cancels, blur
  commits).
- Lets you **activate** a CV (the prior active one demotes itself in
  the same PATCH).
- Has a delete button with a confirm prompt.
- Shows a **chunk inspector** for the selected CV: status, version,
  chunk count, and a collapsible list of chunk excerpts (first 240
  chars each) with ordinality badges and token counts.

## Wiring smoke test

Hermetic, no-network. Run it any time after a refactor:

```bash
npm run smoke:rag
```

It reads the source files and asserts:

- The `Citation` shape is stable (8 fields).
- `runAssistant` accepts a `retrieveCvChunks` seam function.
- `runGeneralChat` awaits `retrieveCvChunks` and surfaces citations.
- The chat route persists `citations` into `chat_messages.citations`.
- The upload route enforces PDF/DOCX, ≤ 20 MB, and writes a `name`.
- The list endpoint joins `cv_chunks(count)` and flattens `chunk_count`.
- The CRUD endpoint filters by `user_id` on every method, demotes the
  prior active CV before promoting a new one (partial unique index),
  refuses to activate a non-ready CV (409), and deletes chunks → row →
  storage in that order.
- The name-column migration is idempotent and has a trgm index.
- The CV page UI hits the right endpoints and renders the inspector.

**47 assertions, runs in <100ms.**

## Manual end-to-end test (live)

If you have a working Supabase + Clerk + Gemini env:

1. `npm run dev`
2. Sign in. Go to `/dashboard/cv`.
3. Drag a small PDF onto the upload card. The card shows
   "Processing..." then flips to "Ready" within a few seconds.
4. Click the row. The inspector shows the version, chunk count, and
   the first five chunk excerpts.
5. Rename the CV via the inline input. Press Enter. The list updates.
6. Upload a second CV. Click "Activate" on it. The first one's Active
   pill disappears; the second one gets it.
7. Go to `/dashboard/chat`. Type "What's on my CV?" — you should see
   the assistant cite one or more chunks inline (`[abc-123-...]`).
   Hover/click the citation body to see the source text and a "view
   source page" link if the parser captured a page image.
8. Delete a CV via the trash icon. The row and chunks are gone; the
   storage bucket object is removed (or a `storageWarning` is
   surfaced if Supabase Storage returned an error).

## What's intentionally not built

- **OCR for scanned PDFs.** A scanned PDF is rejected with
  `code: "needs_ocr"` so the user gets a clear message. Wiring up an
  OCR backend (Tesseract, Google Document AI) is a future-pillar
  concern.
- **Vector index.** pgvector <0.5.0 caps both ivfflat and hnsw at
  2000-dim; our embeddings are 3072-dim. The brute-force cosine scan
  is fine for per-user chunk counts in the tens. When chunk counts
  grow past ~500/user, switch to a 2000-dim embedding model or
  upgrade pgvector.
