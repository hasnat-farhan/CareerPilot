// Debug script: call the hunter agent directly with a known query and
// dump (a) the raw jobs from fanOutSearch, (b) the final HunterResult.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { runHunter, type HunterResult } from "../lib/agents/hunter";
import { fanOutSearch } from "../lib/agents/sources";

async function main() {
  const query = "Software consultant roles in London";
  console.log("\n=== STEP 1: fanOutSearch ===");
  const raw = await fanOutSearch(query);
  console.log(`raw count: ${raw.length}`);
  if (raw.length > 0) {
    console.log("first raw job sample:", JSON.stringify(raw[0], null, 2).slice(0, 500));
    console.log("sources:", Array.from(new Set(raw.map((j) => j.source))));
  } else {
    console.log("EMPTY fanOut — sources returned nothing");
  }

  console.log("\n=== STEP 2: runHunter ===");
  const result: HunterResult = await runHunter("debug-user", query);
  console.log("reasoning:", result.reasoning);
  console.log("model:", result.model);
  console.log("totalCandidates:", result.totalCandidates);
  console.log("jobs.length:", result.jobs.length);
  console.log("sourcesUsed:", result.sourcesUsed);
  console.log("degraded:", result.degraded);
  if (result.jobs.length > 0) {
    console.log("first job:", JSON.stringify(result.jobs[0], null, 2));
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
