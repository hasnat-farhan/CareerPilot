careerpilot/
├── app/
│   ├── layout.tsx                          # Root: Inter + Roboto, ClerkProvider
│   ├── globals.css                         # Tailwind base + brand tokens
│   ├── page.tsx                            # Marketing landing
│   ├── (auth)/
│   │   ├── sign-in/[[...sign-in]]/page.tsx
│   │   └── sign-up/[[...sign-up]]/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx                      # Auth-gated shell w/ AppHeader
│   │   ├── dashboard/page.tsx              # Pillar 4: real-data progress dashboard
│   │   ├── cv/page.tsx                     # Pillar 2: upload + manage CVs (RAG)
│   │   ├── hunter/page.tsx                 # Pillar 1: Job Hunter Agent + cards
│   │   ├── fit-score/page.tsx              # Pillar 3: compute % match
│   │   ├── chat/page.tsx                   # Pillar 3: RAG Assistant (5 intents)
│   │   ├── tracker/page.tsx                # Pillar 4: Kanban (Applied/Interview/Offer/Rejected)
│   │   └── calendar/page.tsx               # Pillar 4: Calendar + to-do + goal deadlines
│   ├── api/
│   │   ├── chat/threads/route.ts           # GET list / POST create thread
│   │   ├── chat/threads/[id]/route.ts      # GET / PATCH (rename) / DELETE
│   │   ├── chat/threads/[id]/messages/route.ts  # POST → runAssistant → persist
│   │   ├── cv/list/route.ts                # GET user's CVs (excludes __warmup__ by default; ?warmup=1 includes them)
│   │   ├── cv/upload/route.ts              # POST → parse → chunk → embed → upsert (sync, 26s) — delegates to lib/cv/ingest
│   │   ├── cv/warmup/route.ts              # POST (x-warmup: 1) → ingestCv(__warmup__.pdf) → deleteCv; cold-start mitigation
│   │   ├── cv/[id]/route.ts                # GET / DELETE single CV
│   │   ├── cv/[id]/chunks/route.ts         # GET CV chunks (debug)
│   │   ├── fit-score/route.ts              # POST / GET latest programmatic fit score
│   │   ├── hunt/route.ts                   # POST → runHunter() with 4-source fan-out + Tavily
│   │   ├── hunt/save/route.ts              # POST save a JobCard to hunter_saved
│   │   ├── goals/route.ts                  # GET / POST career goals
│   │   ├── goals/[id]/route.ts             # PATCH / DELETE
│   │   ├── todos/route.ts                  # GET (range) / POST
│   │   ├── todos/[id]/route.ts             # PATCH (toggle done) / DELETE
│   │   ├── tracker/applications/route.ts   # GET list / POST (from hunter_saved or manual)
│   │   ├── tracker/applications/[id]/route.ts  # PATCH (status/notes) / DELETE
│   │   └── health/ai/route.ts              # GET → { usage: getUsage() } per-model RPD table
│   └── components/
│       ├── app-header.tsx                  # In-app nav (Dashboard / CV / Hunter / Fit / Chat / Tracker / Calendar)
│       ├── auth-cta.tsx
│       ├── supabase-connection-test.tsx
│       └── warmup-provider.tsx             # Client context: polls /api/cv/list?warmup=1, locks /cv upload UI during warmup
├── lib/
│   ├── utils.ts                            # cn() helper
│   ├── agents/
│   │   ├── hunter.ts                       # Job Hunter Agent (Gemini + 4 source fan-out + Tavily web search)
│   │   ├── assistant.ts                    # 5-intent router (readiness / gap / roadmap / cover_letter / general)
│   │   ├── fitScore.ts                     # 60% skill + 30% semantic + 10% experience/edu
│   │   └── sources/                        # 4 live job-board adapters (Tavily lives in hunter.ts)
│   │       ├── index.ts                    #   fan-out, dedupe, ranking
│   │       ├── types.ts                    #   shared Job / JobCard / Source types
│   │       ├── remoteok.ts                 #   RemoteOK
│   │       ├── arbeitnow.ts                #   Arbeitnow
│   │       ├── themuse.ts                  #   The Muse
│   │       └── adzuna.ts                   #   Adzuna (job board API)
│   ├── ai/
│   │   ├── provider.ts                     # chatComplete, streamChat, embedText, embedBatch
│   │   ├── models.ts                       # Quality + economy tier model rotators + getUsage()
│   │   ├── embeddings.ts                   # gemini-embedding-2 (3072-dim)
│   │   ├── resilience.ts                   # Circuit breaker + withBackoff
│   │   ├── rate-limit.ts                   # No-op shim (rate limiter removed; chatGate/embedGate kept for back-compat)
│   │   └── parse-json.ts                   # parseJsonSafe() — robust LLM-JSON extraction
│   ├── auth/require-user.ts                # Clerk guard (throws 401 Response)
│   ├── cv/
│   │   ├── parse.ts                        # PDF (unpdf) + DOCX (mammoth)
│   │   ├── chunk.ts                        # Regex section splitter
│   │   ├── ingest.ts                       # ingestCv() / deleteCv() / WARMUP_NAME_PREFIX — shared by upload + warmup
│   │   └── mammoth.d.ts                    # Type shim
│   ├── data/benchmarks/
│   │   ├── types.ts                        # 4 static benchmark role profiles
│   │   ├── dynamic.ts                      # On-demand synthesis (cached, repaired)
│   │   └── index.ts                        # resolveBenchmark()
│   ├── productivity/
│   │   ├── types.ts                        # Application, Todo, Goal, WeeklyStats
│   │   └── streak.ts                       # computeStreak(userId)
│   ├── rag/retrieve-cv.ts                  # match_cv_chunks RPC wrapper
│   └── supabase/
│       ├── client.ts                       # Browser client
│       ├── server.ts                       # Server client (cookie-aware, anon)
│       ├── admin.ts                        # Service-role client (RLS bypass)
│       └── middleware.ts                   # Cookie refresh on request+response
├── scripts/
│   ├── adzuna-probe.mjs                    # Smoke test for Adzuna API
│   ├── smoke-rag.mjs                       # Smoke test for CV RAG
│   ├── smoke-tavily.ts                     # Smoke test for Tavily
│   ├── debug-hunter.ts                     # Ad-hoc hunter debug
│   ├── seed-eval-cv.ts                     # Seeds synthetic CV into cvs + cv_chunks for `user_eval_demo`
│   ├── inspect-saved.ts                    # Dump hunter_saved rows for a user
│   ├── make-warmup-pdf.mjs                 # One-shot generator for public/warmup.pdf
│   ├── run-evals.cmd                       # Win helper: spin up dev server + run evals/run.ts
│   ├── start-dev.cmd                       # Win helper: `next dev` with the right env
│   ├── dev-eval.mjs                        # Dev server boot + curl-based eval trigger
│   └── dev-eval-detached.mjs               # Same, but logs to scripts/.next-dev.log (gitignored)
├── supabase/migrations/                    # 12 files, ordered by date prefix
│   ├── 20260605_chat_history.sql           # chat_threads, chat_messages + RLS deny-all
│   ├── 20260605_chat_assistant_mode.sql    # mode + structured_result columns
│   ├── 20260605_cv.sql                     # cvs, cv_chunks + match_cv_chunks RPC
│   ├── 20260605_fit_scores.sql             # fit_scores table
│   ├── 20260605_hunter.sql                 # hunter_runs, hunter_saved
│   ├── 20260606_cvs_storage_bucket.sql     # Supabase Storage 'cvs' bucket
│   ├── 20260606_cv_ingest_status.sql       # ingest_status enum on cvs
│   ├── 20260606_cv_name.sql                # display_name on cvs
│   ├── 20260607_productivity.sql           # applications, goals, todos, v_weekly_stats
│   ├── 20260607_cvs_one_active_per_user.sql  # one active CV per user invariant
│   ├── 20260607_cv_header_section.sql      # synthetic HEADER chunk for RAG
│   └── 20260607_hunter_saved_enrichment.sql  # extra columns on hunter_saved
├── evals/                                  # Evaluation suite (bonus deliverable)
│   ├── cases.json                          # 14 golden test cases (v2.0.0 schema)
│   ├── run.ts                              # Node runner → evals/results.md
│   ├── results.md                          # Latest run output (committed for the judge demo)
│   ├── README.md                           # How to run + how to add a case
│   └── demo_cvs/                           # 7 real resumes (3 DOCX + 3 PDF + 1 anonymised PDF)
│       ├── README.md                       # Per-file personas + how to upload
│       ├── cv1_senior_engineer_marcus_ellison.{docx,pdf}
│       ├── cv2_fresher_priya_nair.{docx,pdf}
│       ├── cv3_basic_graduate_thomas_oduya.docx
│       └── cv.pdf
├── docs/
│   └── SYSTEM_DESIGN.md                    # Data flow, scale-to-10k, cost, bottlenecks
├── public/                                 # Static assets (logo, OG image, warmup.pdf)
├── middleware.ts                           # clerkMiddleware() default; auth enforced in lib/auth/require-user.ts
├── netlify.toml                            # Netlify deploy w/ Next plugin + 26s upload timeout
├── next.config.ts                          # serverExternalPackages: pdf-parse, pdfjs-dist
├── next-env.d.ts                           # (gitignored — auto-generated by Next)
├── tailwind.config.ts                      # Brand tokens: primary #003893, secondary #2D2D2D
├── postcss.config.mjs
├── tsconfig.json
├── package.json
├── .env.local                              # CLERK_*, SUPABASE_*, GEMINI_API_KEY, TAVILY_*, ADZUNA_*  (gitignored)
├── README.md
├── structure.md                            # this file
├── plan.md                                 # Pillar 4 sprint plan
├── brand-dna.md                            # Brand voice & design tokens
└── chat-page-source.md                     # Reference snapshot of chat UI
