# CareerPilot — Evaluation Suite

A golden-case eval harness that hits the live API surfaces and grades each response against a fixed rubric. Used to demo "5+ case eval suite" to Codesprint Poridhi judges.

## Layout

```
evals/
  cases.json     # 9 golden cases (chat intents, fit-score, hunter)
  run.ts         # Node runner → evals/results.md
  README.md      # this file
  results.md     # generated; safe to commit for the demo
```

## Quickstart

```bash
# 1. Start the eval-mode dev server (in one terminal)
npm run dev:eval
#    This sets EVAL_BYPASS_AUTH=1, so the server accepts the
#    `x-eval-user-id` header in place of a Clerk session.

# 2. Run the suite (in another terminal)
npm run evals
#    Or, equivalently:
#    EVAL_BASE_URL=http://localhost:3000 npx tsx evals/run.ts
```

**No JWT, no Clerk login, no browser.** That's the whole point of the
`EVAL_BYPASS_AUTH` mode — judges can run the suite with two shell
commands, no extra setup.

The runner writes `evals/results.md` with a verdict table and per-case detail.

Exit code: `0` if weighted score ≥ 0.70, else `1`. Wire it into CI:

```yaml
- run: npm run dev:eval &
- run: npm run evals
```

## Cases

| ID | Surface | What it checks |
|---|---|---|
| `assistant.readiness` | chat | intent = `readiness`; reply mentions "ready"/"gap"; ≥1 citation |
| `assistant.gap` | chat | intent = `gap`; reply mentions "improve"/"learn"; structured `{gaps: [...]}` |
| `assistant.roadmap` | chat | intent = `roadmap`; reply mentions "phase"/"week"/"month"; structured `{phases: [...]}` |
| `assistant.cover_letter` | chat | intent = `cover_letter`; ≥250 chars; ≥1 citation; letter-shaped open/close |
| `assistant.conversational_memory` | chat | 2-turn thread; reply contains "Sarah" and "5" |
| `assistant.off_topic_deflection` | chat | reply steers back to career topics |
| `fit_score.strong_match` | fit-score | score 70–100 on a CV-tuned JD; weights sum to 1.0 |
| `fit_score.weak_match` | fit-score | score 0–40 on a mismatched JD; weights sum to 1.0 |
| `hunter.basic` | hunter | fan-out returns ≥3 cards, each with title/company/url/source, no dupes |

## Scoring

Each case is graded:

| Score | Meaning |
|---|---|
| 1.00 | All assertions pass |
| 0.75 | All hard assertions pass; one soft assertion fails |
| 0.50 | Two assertions fail; case is salvageable |
| 0.25 | Most assertions fail; case is broken |
| 0.00 | Case crashes or returns 5xx |

The final score is a weighted mean (each case's `weight` field, default 1). Threshold: **0.70**.

## Adding a case

Append to `cases.json`:

```json
{
  "id": "assistant.interview_prep",
  "name": "Assistant — interview prep",
  "surface": "chat",
  "weight": 1,
  "input": {
    "threadTitle": "Interview prep",
    "messages": [{ "role": "user", "content": "Prep me for a Senior FE loop." }]
  },
  "expect": {
    "mode": "general",
    "replyContainsAny": ["interview", "prep", "round"],
    "citationsCount": { "min": 1 }
  }
}
```

Available assertions per surface:

- **chat** — `mode`, `replyContainsAny`, `replyContainsAll`, `citationsCount.min`, `minReplyLength`, `structuredResultShape.{type,requiredKeys}`
- **fit-score** — `scoreRange.{min,max}`, `breakdownShape.requiredKeys`, `weightsSumTo`
- **hunter** — `minResults`, `maxResults`, `everyCardHas`, `uniqueBy`

## Why no mocking?

The point of the eval is to validate the *deployed* system. Mocking the LLM would test the harness, not the product. The runner talks to real endpoints, the LLM is real, the cost is a few cents per run.

## Headless / CI auth

None required — `EVAL_BYPASS_AUTH=1` is the entire auth story for evals.
The server impersonates whichever user id is passed in the
`x-eval-user-id` request header (default `user_eval_demo`). For CI:

```yaml
- run: npm run dev:eval &
- run: npm run evals
  env:
    EVAL_BASE_URL: http://localhost:3000
    EVAL_USER_ID: user_eval_demo   # optional; default
```

### How the bypass works

`lib/auth/require-user.ts` checks `EVAL_BYPASS_AUTH` at runtime. When
`"1"`, it skips the Clerk `auth()` call entirely and reads the user id
from the `x-eval-user-id` request header. When unset, the function
behaves exactly as before — no path is weakened in production.
