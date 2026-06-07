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
# 1. Start the dev server (in one terminal)
npm run dev

# 2. Sign in to the dashboard in a browser, copy the __session cookie

# 3. Run the suite (in another terminal)
EVAL_BASE_URL=http://localhost:3000 \
EVAL_AUTH_TOKEN="<paste the __session cookie value>" \
npx tsx evals/run.ts

# Or via ts-node:
EVAL_AUTH_TOKEN=... npx ts-node evals/run.ts
```

The runner writes `evals/results.md` with a verdict table and per-case detail.

Exit code: `0` if weighted score ≥ 0.70, else `1`. Wire it into CI:

```yaml
- run: npx tsx evals/run.ts
  env:
    EVAL_BASE_URL: http://localhost:3000
    EVAL_AUTH_TOKEN: ${{ secrets.EVAL_SESSION }}
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

For CI, mint a Clerk testing token:

```bash
clerk testing-tokens create --user user_test_xxx
```

Then:

```bash
EVAL_AUTH_TOKEN=$(clerk testing-tokens create --user user_test_xxx --json | jq -r .jwt) \
EVAL_BASE_URL=http://localhost:3000 \
npx tsx evals/run.ts
```

(Or wire whichever session-mint API you prefer; the runner only cares that `__session=<token>` is a valid Clerk session cookie for a user with at least one CV uploaded.)
