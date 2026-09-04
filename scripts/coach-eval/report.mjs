// Aggregate results + judge verdicts into out/<run>/report.md.
//
//   node report.mjs --out out/run1

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function arg(k, d) {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const pct = (a, b) => (b === 0 ? "-" : `${Math.round((100 * a) / b)}%`);
const q = (xs, p) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

async function main() {
  const out = arg("out");
  if (!out) throw new Error("--out <dir> required");
  const dir = join(out, "traces");
  const traces = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".json"))) {
    traces.push(JSON.parse(await readFile(join(dir, f), "utf8")));
  }
  const configs = [...new Set(traces.map((t) => t.config))];
  const caseIds = [...new Set(traces.map((t) => t.case))];

  const lines = [];
  lines.push(`# Coach eval report`, ``, `${traces.length} turns, ${configs.length} configs, ${caseIds.length} cases.`, ``);
  lines.push(`## By config`, ``);
  lines.push(`| config | turns | checks pass | judge claims pass | both | errors | mean cost | p50 s | p90 s | mean words |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const c of configs) {
    const ts = traces.filter((t) => t.config === c);
    const checksPass = ts.filter((t) => t.checksPassed).length;
    const claims = ts.flatMap((t) => t.judge?.claims ?? []);
    const claimsPass = claims.filter((x) => x.pass).length;
    const both = ts.filter((t) => t.checksPassed && (t.judge?.claims ?? []).every((x) => x.pass)).length;
    const errors = ts.filter((t) => t.error).length;
    const cost = ts.reduce((n, t) => n + t.cost, 0) / ts.length;
    const lat = ts.map((t) => t.latencyMs / 1000);
    const words = ts.reduce((n, t) => n + t.words, 0) / ts.length;
    lines.push(
      `| ${c} | ${ts.length} | ${pct(checksPass, ts.length)} | ${pct(claimsPass, claims.length)} | ${pct(both, ts.length)} | ${errors} | $${cost.toFixed(3)} | ${q(lat, 0.5).toFixed(1)} | ${q(lat, 0.9).toFixed(1)} | ${Math.round(words)} |`,
    );
  }

  lines.push(``, `## By case (fraction of trials passing ALL checks and ALL claims)`, ``);
  lines.push(`| case | note | ${configs.join(" | ")} |`);
  lines.push(`|---|---|${configs.map(() => "---").join("|")}|`);
  for (const id of caseIds) {
    const note = traces.find((t) => t.case === id)?.note ?? "";
    const cells = configs.map((c) => {
      const ts = traces.filter((t) => t.config === c && t.case === id);
      const ok = ts.filter((t) => t.checksPassed && (t.judge?.claims ?? []).every((x) => x.pass)).length;
      return ts.length ? `${ok}/${ts.length}` : "-";
    });
    lines.push(`| ${id} | ${note} | ${cells.join(" | ")} |`);
  }

  lines.push(``, `## Failures`, ``);
  for (const t of traces) {
    const failedChecks = Object.entries(t.checks).filter(([, v]) => !v.pass);
    const failedClaims = (t.judge?.claims ?? []).filter((x) => !x.pass);
    if (failedChecks.length === 0 && failedClaims.length === 0 && !t.error) continue;
    lines.push(`### ${t.config} · ${t.case} · trial ${t.trial}`, ``);
    if (t.error) lines.push(`- error: ${t.error}`);
    for (const [k, v] of failedChecks) lines.push(`- check ${k}: ${v.detail}`);
    for (const c of failedClaims) lines.push(`- claim: ${c.claim}\n  - ${c.evidence}`);
    lines.push(`- tools: ${t.tools.join(", ") || "none"}`);
    lines.push(`- answer: ${t.answer.replace(/\s+/g, " ").slice(0, 400)}${t.answer.length > 400 ? "…" : ""}`, ``);
  }

  await writeFile(join(out, "report.md"), lines.join("\n"));
  console.log(lines.slice(0, 12 + configs.length).join("\n"));
  console.log(`\nwritten ${join(out, "report.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
