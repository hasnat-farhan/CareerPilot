// Adzuna coverage probe — runs the source module against several queries
// and locations, prints the per-case result count and a sample URL host
// so we can confirm the country routing is correct.
import { adzunaSource } from "../lib/agents/sources/adzuna.ts";

const cases = [
  ["software engineer", "UK"],
  ["product manager", "London"],
  ["data analyst", "US"],
  ["backend developer", "Germany"],
  ["software engineer", "Berlin"],
  ["frontend developer", "Berlin, Germany"],
  ["data scientist", "Paris"],
  ["product manager", "Singapore"],
  ["engineer", "Toronto"],
];

for (const [q, loc] of cases) {
  const r = await adzunaSource.search(q, { location: loc });
  const sample = r[0];
  const host = sample?.url ? new URL(sample.url).host : "-";
  const sLoc = sample?.location?.slice(0, 40) ?? "-";
  console.log(`${q} in ${loc} -> ${r.length} results | loc: ${sLoc} | host: ${host}`);
}
