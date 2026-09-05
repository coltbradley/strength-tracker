// Drive one case against a running serve.mjs, for the subagent path.
//
//   node agent-case.mjs --case v12 --setup    reset the DB, write the pack,
//                                             delete any stale answer
//   node agent-case.mjs --case v12 --grade    read the answer file, run the
//                                             checks, print the verdict
//   node agent-case.mjs --summary             every trace written so far

import { readFile, unlink, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out", "agent");
const CONTROL = "http://127.0.0.1:54331";

function arg(k, d) {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const has = (k) => process.argv.includes(`--${k}`);

async function post(path, body) {
  const r = await fetch(CONTROL + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

if (has("summary")) {
  const files = (await readdir(OUT)).filter((f) => f.endsWith(".trace.json")).sort();
  const rows = [];
  for (const f of files) rows.push(JSON.parse(await readFile(join(OUT, f), "utf8")));
  console.log(`| case | driver | checks | tools | words |`);
  console.log(`|---|---|---|---|---|`);
  for (const t of rows) {
    const failed = Object.entries(t.checks).filter(([, v]) => !v.pass).map(([k]) => k);
    console.log(
      `| ${t.case} | ${t.driver ?? "?"} | ${failed.length ? "FAIL: " + failed.join(", ") : "pass"} | ${t.tools.join(", ") || "none"} | ${t.words} |`,
    );
  }
  process.exit(0);
}

const id = arg("case");
if (!id) throw new Error("--case <id> required");

if (has("setup")) {
  await unlink(join(OUT, `${id}.answer.txt`)).catch(() => {});
  const r = await post("/setup", { case: id });
  console.log(`${r.case}: ${r.note}`);
  console.log(`pack:   ${r.pack}`);
  console.log(`answer: ${r.answer}`);
} else if (has("grade")) {
  let answer = "";
  try {
    answer = await readFile(join(OUT, `${id}.answer.txt`), "utf8");
  } catch {
    console.log(`${id}: NO ANSWER FILE — the driver did not write one`);
  }
  const model = arg("model", "unknown");
  const t = await post("/grade", { case: id, answer });
  const failed = Object.entries(t.checks).filter(([, v]) => !v.pass);
  console.log(`\n${t.case} (${model}): ${failed.length === 0 ? "ALL CHECKS PASS" : "FAILED " + failed.map(([k]) => k).join(", ")}`);
  console.log(`tools: ${t.tools.join(", ") || "none"}`);
  for (const [k, v] of Object.entries(t.checks)) console.log(`  ${v.pass ? "ok  " : "FAIL"} ${k}: ${v.detail}`);
  console.log(`\nanswer (${t.words} words):\n${t.answer}`);
} else {
  throw new Error("pass --setup, --grade or --summary");
}
