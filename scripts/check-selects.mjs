// Every column the code SELECTs must exist.
//
// get_program shipped selecting `programs.starts_on`, a column that has never
// existed. Nothing caught it: it typechecks (PostgREST select strings are just
// strings), the tool registers fine, and the failure only appears when someone
// actually calls that tool — which the connector smoke test did not, because
// it exercised a different one.
//
// So: parse every `.from("relation")` / `.select("a,b,c")` pair out of the MCP
// tools and the PWA data layer, stand the real schema up in PGlite, and check
// each column against it. Embedded selects (`planned_workouts(label)`) and
// aggregate forms are skipped — they are PostgREST syntax, not column lists.

import { readFileSync, readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = new URL("..", import.meta.url).pathname;

/** The real migration chain, in PGlite — same approach as validate-db.mjs. */
async function standUpSchema(db) {
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
    create role authenticated login;
    create role anon login;
  `);
  const dir = join(ROOT, "supabase", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await db.exec(await readFile(join(dir, f), "utf8"));
}

const FILES = [
  ...readdirSync(join(ROOT, "supabase/functions/mcp-server/tools"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join("supabase/functions/mcp-server/tools", f)),
  // Shared readers under lib/ select too (prescriptions.ts, lastTime.ts): a
  // column that only a tool file can misname is not the only kind.
  ...readdirSync(join(ROOT, "supabase/functions/mcp-server/lib"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join("supabase/functions/mcp-server/lib", f)),
  "pwa/src/lib/data.ts",
  "pwa/src/lib/coach.ts",
  "pwa/src/lib/review.ts",
];

/**
 * `.from("x")` … `.select("a, b")` within the same statement.
 *
 * Deliberately simple: it looks for a `.from(...)` and takes the next
 * `.select(...)` after it. A false pair would only ever cause a spurious
 * failure, which is cheap to notice, unlike the silent one this exists to stop.
 */
function pairs(source) {
  const out = [];
  // The gap must not contain another `.from(` or the pair spans two
  // statements and the columns get checked against the wrong relation.
  const re =
    /\.from\(\s*"([a-z_0-9]+)"\s*\)((?:(?!\.from\()[\s\S]){0,900}?)\.select\(\s*([\s\S]*?)\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, relation, , rawArg] = m;
    // Only literal strings; a built-up variable is not checkable here.
    const literal = [...rawArg.matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
    if (!literal.trim()) continue;
    if (literal.includes("*")) continue;
    out.push({ relation, columns: literal });
  }
  return out;
}

function columnsOf(list) {
  return list
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    // `planned_workouts(label)` is an embedded resource, `id.count()` an
    // aggregate — neither is a column on the parent relation.
    .filter((c) => !c.includes("(") && !c.includes(")"));
}

const db = new PGlite();
await standUpSchema(db);

const known = new Map();
const rows = await db.query(`
  select table_name, column_name from information_schema.columns
  where table_schema = 'public'
`);
for (const r of rows.rows) {
  if (!known.has(r.table_name)) known.set(r.table_name, new Set());
  known.get(r.table_name).add(r.column_name);
}

let failures = 0;
let checked = 0;
for (const file of FILES) {
  const source = readFileSync(join(ROOT, file), "utf8");
  for (const { relation, columns } of pairs(source)) {
    const cols = known.get(relation);
    if (!cols) {
      console.log(`  FAIL  ${file}: unknown relation "${relation}"`);
      failures += 1;
      continue;
    }
    for (const c of columnsOf(columns)) {
      checked += 1;
      if (!cols.has(c)) {
        console.log(`  FAIL  ${file}: ${relation} has no column "${c}"`);
        failures += 1;
      }
    }
  }
}

console.log(
  failures === 0
    ? `  ok    ${checked} selected columns all exist`
    : `\n${failures} BAD COLUMN REFERENCES`,
);
await db.close();
process.exit(failures === 0 ? 0 : 1);
