// Quick verification that the 6 demo CVs landed in Supabase with
// status='ready' and that cv_chunks has the right number of rows.
// Run with: node scripts/verify-cvs.mjs
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = "user_eval_demo";

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: cvs, error: cvErr } = await sb
  .from("cvs")
  .select("id, file_name, status, is_active, created_at, updated_at")
  .eq("user_id", userId)
  .order("created_at", { ascending: false });

if (cvErr) {
  console.error("CV query failed:", cvErr.message);
  process.exit(1);
}

console.log(`\n=== ${cvs.length} CV rows for ${userId} ===`);
for (const cv of cvs) {
  const { count, error: cErr } = await sb
    .from("cv_chunks")
    .select("id", { count: "exact", head: true })
    .eq("cv_id", cv.id);
  const n = cErr ? `ERR:${cErr.message}` : String(count);
  console.log(
    `  ${cv.file_name}  status=${cv.status}  active=${cv.is_active}  chunks=${n}`,
  );
}

const statuses = cvs.reduce((acc, c) => {
  acc[c.status] = (acc[c.status] ?? 0) + 1;
  return acc;
}, {});
console.log("\nstatus breakdown:", statuses);

const allReady = cvs.length > 0 && cvs.every((c) => c.status === "ready");
const allHaveChunks = await Promise.all(
  cvs.map(async (c) => {
    const { count } = await sb
      .from("cv_chunks")
      .select("id", { count: "exact", head: true })
      .eq("cv_id", c.id);
    return (count ?? 0) > 0;
  }),
);
const allChunked = allHaveChunks.every(Boolean);

console.log(
  `\nVERIFY: allReady=${allReady}  allChunked=${allChunked}  total=${cvs.length}`,
);
process.exit(allReady && allChunked ? 0 : 2);
