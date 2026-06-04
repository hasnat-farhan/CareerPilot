# CareerPilot

Put your job search on autopilot. CareerPilot is a Next.js 16 SaaS that reads your CV, hunts live roles, scores every match, and tracks every application.

## Stack

- **Next.js 16** (App Router, TypeScript strict)
- **Tailwind CSS** with brand tokens from `brand-dna.md`
- **Lucide React** icons
- **Clerk** (auth), **Supabase** (data + pgvector), **Gemini** (`gemini-embedding-2` + `gemini-3.5-flash` for RAG + agents), **Tavily / Adzuna** (live job data), **Inngest** (background CV ingestion)

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in keys
npm run dev
```

## Brand DNA

- Primary: `#003893` (Brand Blue)
- Secondary: `#2D2D2D` (Dark Charcoal)
- Background: `#FFFFFF`
- Headings: Inter / Body: Roboto
- Tone: action-oriented, direct, empowering

## Environment variables

| Key | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes | from [Clerk](https://dashboard.clerk.com) |
| `CLERK_SECRET_KEY` | yes | server-side |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | new `sb_publishable_…` key, NOT the legacy anon JWT |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | service role, server-only |
| `GEMINI_API_KEY` | yes | raw API key for [Google AI Studio](https://aistudio.google.com/apikey). Send as `?key=` query param — the SDK constructor takes the raw string. |
| `TAVILY_API_KEY` | yes | web search |
| `ADZUNA_API_ID` / `ADZUNA_API_KEY` | yes | job board |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | yes | background CV ingestion |

> ⚠️ **Supabase pgvector column size:** Gemini's `gemini-embedding-2` returns **3072-dim** vectors (not 1536 like OpenAI's `text-embedding-3-small`, and not 768 like the older `text-embedding-004`). Resize the column before ingesting any CV chunks:
>
> ```sql
> ALTER TABLE cv_chunks
>   ALTER COLUMN embedding TYPE vector(3072)
>   USING embedding::vector(3072);
> ```
>
> If you also have a `match_cv_chunks` RPC, update its `vector` argument to `vector(3072)` and re-create the index. The HNSW index on a 3072-dim column is roughly 2× the size of one on 1536-dim.

See `brand-dna.md` and `structure.md` for the full plan.
