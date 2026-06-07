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
│   │   ├── cv/list/route.ts                # GET user's CVs
│   │   ├── cv/upload/route.ts              # POST → parse → chunk → embed → upsert (sync, 26s)
│   │   ├── cv/[id]/route.ts                # GET / DELETE single CV
│   │   ├── cv/[id]/chunks/route.ts         # GET CV chunks (debug)
│   │   ├── fit-score/route.ts              # POST / GET latest programmatic fit score
│   │   ├── hunt/route.ts                   # POST → runHunter() with multi-source fan-out
│   │   ├── hunt/save/route.ts              # POST save a JobCard to hunter_saved
│   │   ├── goals/route.ts                  # GET / POST career goals
│   │   ├── goals/[id]/route.ts             # PATCH / DELETE
│   │   ├── todos/route.ts                  # GET (range) / POST
│   │   ├── todos/[id]/route.ts             # PATCH (toggle done) / DELETE
│   │   ├── tracker/applications/route.ts   # GET list / POST (from hunter_saved or manual)
│   │   └── tracker/applications/[id]/route.ts  # PATCH (status/notes) / DELETE
│   └── components/
│       ├── app-header.tsx                  # In-app nav (Dashboard / CV / Hunter / Fit / Chat / Tracker / Calendar)
│       ├── auth-cta.tsx
│       └── supabase-connection-test.tsx
├── lib/
│   ├── utils.ts                            # cn() helper
│   ├── agents/
│   │   ├── hunter.ts                       # Job Hunter Agent (Gemini + 5 source fan-out)
│   │   ├── assistant.ts                    # 5-intent router (readiness / gap / roadmap / cover_letter / general)
│   │   ├── fitScore.ts                     # 60% skill + 30% semantic + 10% experience/edu
│   │   └── sources/                        # 5 live job sources
│   │       ├── index.ts                    #   fan-out, dedupe, ranking
│   │       ├── types.ts                    #   shared Job / JobCard / Source types
│   │       ├── remoteok.ts                 #   RemoteOK
│   │       ├── arbeitnow.ts                #   Arbeitnow
│   │       ├── themuse.ts                  #   The Muse
│   │       ├── adzuna.ts                   #   Adzuna (job board API)
│   │       └── tavily.ts                   #   Tavily (web search)
│   ├── ai/
│   │   ├── provider.ts                     # chatComplete, streamChat, embedText, embedBatch
│   │   ├── models.ts                       # Quality + economy tier model rotators
│   │   ├── embeddings.ts                   # gemini-embedding-2 (3072-dim)
│   │   ├── resilience.ts                   # Circuit breaker + withBackoff
│   │   └── rate-limit.ts                   # No-op shim (slot for future limiter)
│   ├── auth/require-user.ts                # Clerk guard (throws 401 Response)
│   ├── cv/
│   │   ├── parse.ts                        # PDF (unpdf) + DOCX (mammoth)
│   │   ├── chunk.ts                        # Regex section splitter
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
│   ├── dev-detached.ps1                    # Dev helpers
│   └── dev-inner.cmd
├── supabase/migrations/
│   ├── 20260605_chat_history.sql           # chat_threads, chat_messages + RLS deny-all
│   ├── 20260605_chat_assistant_mode.sql    # mode + structured_result columns
│   ├── 20260605_cv.sql                     # cvs, cv_chunks + match_cv_chunks RPC
│   ├── 20260605_fit_scores.sql             # fit_scores table
│   ├── 20260605_hunter.sql                 # hunter_runs, hunter_saved
│   ├── 20260606_cvs_storage_bucket.sql     # Supabase Storage 'cvs' bucket
│   ├── 20260606_cv_ingest_status.sql       # ingest_status enum on cvs
│   ├── 20260606_cv_name.sql                # display_name on cvs
│   └── 20260607_productivity.sql           # applications, goals, todos, v_weekly_stats
├── evals/                                  # Evaluation suite (bonus deliverable)
│   ├── cases.json                          # 8 golden test cases
│   ├── run.ts                              # Node runner → evals/results.md
│   └── README.md
├── docs/
│   ├── SYSTEM_DESIGN.md                    # Data flow, scale-to-10k, cost, bottlenecks
│   └── architecture.png                    # Architecture diagram (TBD)
├── public/                                 # Static assets (logo, OG image)
├── middleware.ts                           # Clerk protect for /(dashboard)/*
├── netlify.toml                            # Netlify deploy w/ Next plugin + 26s upload timeout
├── next.config.ts
├── next-env.d.ts
├── tailwind.config.ts                      # Brand tokens: primary #003893, secondary #2D2D2D
├── postcss.config.mjs
├── tsconfig.json
├── package.json
├── .env.local                              # CLERK_*, SUPABASE_*, GEMINI_API_KEY, TAVILY_*, ADZUNA_*
├── README.md
├── structure.md                            # this file
├── plan.md                                 # Pillar 4 sprint plan
├── brand-dna.md                            # Brand voice & design tokens
├── chat-page-source.md                     # Reference snapshot of chat UI
└── Codesprint_poridhi.pdf                  # Brief
