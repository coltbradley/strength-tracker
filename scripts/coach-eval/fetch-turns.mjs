// Pull one user's coach transcript out of `coach_usage` into the local file the
// Valentine cases replay. The output is GITIGNORED on purpose: it is a person's
// private conversation with their coach and this repository is public.
//
//   node fetch-turns.mjs --user <uuid> [--out valentine-turns.json]
//
// Needs the Supabase CLI linked to the project (`supabase link`), the same way
// scripts/issue-mcp-token.mjs does. Ask the person first.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

function arg(k, d) {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
}

const user = arg("user");
if (!user) {
  console.error("--user <uuid> is required (see auth.users, or coach_usage.user_id)");
  process.exit(1);
}
const out = join(here, arg("out", "valentine-turns.json"));

const sql = `select created_at, prompt, response, tools_used from coach_usage
             where user_id = '${user}' and prompt is not null
             order by created_at`;

const { stdout } = await run("supabase", ["db", "query", sql, "--linked"], {
  cwd: join(here, "..", ".."),
  maxBuffer: 64 * 1024 * 1024,
});

const rows = JSON.parse(stdout).rows.map((r) => ({
  at: r.created_at,
  // The PWA prepends the context block to the last user turn; the cases supply
  // their own, so strip it here.
  user: (r.prompt ?? "").replace(/<current_context>[\s\S]*?<\/current_context>\s*/, ""),
  ctx: ((r.prompt ?? "").match(/<current_context>\n([\s\S]*?)\n<\/current_context>/) ?? [])[1] ?? null,
  assistant: r.response ?? "",
  tools: r.tools_used,
}));

await writeFile(out, JSON.stringify(rows, null, 2));
console.log(`${rows.length} turns -> ${out}`);
if (rows.length !== 13) {
  console.log("note: the Valentine cases in cases.mjs expect 13 turns from 2026-08-31.");
}
