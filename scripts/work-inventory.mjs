#!/usr/bin/env node
// Work inventory: what is already in flight before anyone starts something new.
//
// Why this exists (docs/decisions.md, 2026-10-01 "Inventory before starting"):
// a Version D redesign was implemented TWICE on the same day — once on
// `codex/version-d-light-plan`, once on `feat/live-workout-d` — because the
// second effort never looked at the remote branches first. The duplicate cost
// a day of work and nearly shipped without the first effort's correctness
// fixes. The same session also found 16 stale branches and two superseded open
// PRs nobody had closed. This script makes the look-around one command:
//
//   node scripts/work-inventory.mjs                 # everything, vs origin/main
//   node scripts/work-inventory.mjs --topic "version d" --paths pwa/src/screens/Session.tsx
//   node scripts/work-inventory.mjs --no-fetch --json
//
// It only READS: it fetches (unless --no-fetch) and runs git/gh queries. It
// never deletes, pushes, or checks anything out.

import { execFileSync } from "node:child_process";

export const STALE_DAYS = 14;

/** Branches that hold build output, not work. Never merged, never "stale". */
export const DEPLOY_BRANCHES = ["gh-pages"];

/** Run a command and return trimmed stdout, or null when it fails. */
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

const git = (...args) => run("git", args);

/**
 * Classify a branch from its numbers. Pure, so it is tested without a repo.
 *  - "base"    the comparison base itself
 *  - "deploy"  a build-output branch (gh-pages): leave it alone
 *  - "merged"  nothing ahead of base: safe to delete
 *  - "active"  unique commits, touched within `staleDays`
 *  - "stale"   unique commits, untouched for longer than that
 */
export function classifyBranch({ name, base, ahead, ageDays }, staleDays = STALE_DAYS) {
  if (name === base) return "base";
  if (DEPLOY_BRANCHES.includes(name.replace(/^origin\//, ""))) return "deploy";
  if (ahead === 0) return "merged";
  return ageDays > staleDays ? "stale" : "active";
}

/** Paths two branches both change relative to base. */
export function overlappingPaths(a, b) {
  const set = new Set(a);
  return [...new Set(b)].filter((p) => set.has(p)).sort();
}

/** Does a branch look like it is about `topic`? Name or commit subjects. */
export function matchesTopic(topic, name, subjects) {
  if (!topic) return false;
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const hay = [name, ...subjects].join("\n").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return words.every((w) => hay.includes(w));
}

/**
 * Tracked symlinks whose target is absolute: a worktree-local path committed
 * by accident (it happened with pwa/node_modules, and `npm ci` then followed
 * it and emptied another checkout). `lsTreeOutput` is `git ls-tree -r` text.
 */
export function absoluteSymlinks(lsTreeOutput, readTarget) {
  return lsTreeOutput
    .split("\n")
    .filter((l) => l.startsWith("120000 "))
    .map((l) => l.split("\t")[1])
    .filter((p) => {
      const t = readTarget(p);
      return typeof t === "string" && t.startsWith("/");
    });
}

function parseArgs(argv) {
  const out = { base: "origin/main", fetch: true, json: false, topic: null, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-fetch") out.fetch = false;
    else if (a === "--json") out.json = true;
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--topic") out.topic = argv[++i];
    else if (a === "--paths") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) out.paths.push(argv[++i]);
    } else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function collect(opts) {
  const warnings = [];
  if (opts.fetch && git("fetch", "--prune", "--quiet", "origin") === null)
    warnings.push("git fetch failed — remote data may be stale");
  if (git("rev-parse", "--is-shallow-repository") === "true")
    warnings.push(
      "shallow clone: ahead/behind counts are unreliable. Run `git fetch --depth=1000 origin` (or --unshallow) first.",
    );

  const now = Date.now();
  const refs = (git(
    "for-each-ref",
    "--format=%(refname:short)\t%(committerdate:unix)\t%(authorname)",
    "refs/remotes/origin",
  ) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter(([n]) => n !== "origin" && !n.endsWith("/HEAD"));

  const branches = refs.map(([name, ts, author]) => {
    const ahead = Number(git("rev-list", "--count", `${opts.base}..${name}`) ?? NaN);
    const behind = Number(git("rev-list", "--count", `${name}..${opts.base}`) ?? NaN);
    const ageDays = Math.floor((now / 1000 - Number(ts)) / 86400);
    const subjects = ahead > 0 ? (git("log", "--format=%s", `${opts.base}..${name}`) ?? "").split("\n").slice(0, 50) : [];
    const files = ahead > 0 ? (git("diff", "--name-only", `${opts.base}...${name}`) ?? "").split("\n").filter(Boolean) : [];
    return {
      name,
      author,
      ageDays,
      ahead,
      behind,
      status: classifyBranch({ name, base: opts.base, ahead, ageDays }),
      topic: matchesTopic(opts.topic, name, subjects),
      overlap: opts.paths.length ? overlappingPaths(files, opts.paths) : [],
      files,
    };
  });

  const worktrees = (git("worktree", "list", "--porcelain") ?? "")
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "(detached)";
      const dirty = (run("git", ["-C", path, "status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length;
      return { path, branch, dirty };
    });

  // Open pull requests, when the GitHub CLI is available and authenticated.
  const repo = git("config", "--get", "remote.origin.url")?.match(/github\.com[/:](.+?)(?:\.git)?$/)?.[1];
  let prs = null;
  if (repo) {
    const raw = run("gh", ["api", `repos/${repo}/pulls?state=open&per_page=100`, "--jq", ".[] | [.number, .head.ref, .title] | @tsv"]);
    if (raw !== null) prs = raw.split("\n").filter(Boolean).map((l) => { const [n, ref, title] = l.split("\t"); return { number: Number(n), ref, title }; });
    else warnings.push("gh unavailable or unauthenticated — open PRs not listed");
  }

  const symlinks = absoluteSymlinks(git("ls-tree", "-r", "HEAD") ?? "", (p) => git("cat-file", "-p", `HEAD:${p}`));
  if (symlinks.length)
    warnings.push(`tracked symlinks with absolute targets on HEAD (commit accident?): ${symlinks.join(", ")}`);

  return { base: opts.base, warnings, worktrees, branches, prs };
}

function render(inv, opts) {
  const lines = [];
  const row = (cells) => `| ${cells.join(" | ")} |`;
  lines.push(`# Work inventory (base ${inv.base})`, "");
  for (const w of inv.warnings) lines.push(`> WARNING: ${w}`);
  if (inv.warnings.length) lines.push("");

  lines.push("## Local worktrees", "", row(["path", "branch", "uncommitted"]), row(["---", "---", "---"]));
  for (const w of inv.worktrees) lines.push(row([w.path, w.branch, String(w.dirty)]));

  const prByRef = new Map((inv.prs ?? []).map((p) => [p.ref, p]));
  const order = { active: 0, stale: 1, merged: 2, deploy: 3, base: 4 };
  const sorted = [...inv.branches].sort((a, b) => order[a.status] - order[b.status] || a.ageDays - b.ageDays);
  lines.push("", "## Remote branches", "", row(["branch", "status", "ahead", "behind", "age (d)", "author", "open PR", "notes"]), row(Array(8).fill("---")));
  for (const b of sorted) {
    const pr = prByRef.get(b.name.replace(/^origin\//, ""));
    const notes = [b.topic ? "MATCHES TOPIC" : "", b.overlap.length ? `touches ${b.overlap.join(", ")}` : ""].filter(Boolean).join("; ");
    lines.push(row([b.name, b.status, String(b.ahead), String(b.behind), String(b.ageDays), b.author, pr ? `#${pr.number}` : "", notes]));
  }

  const flagged = sorted.filter((b) => b.topic || b.overlap.length);
  if (opts.topic || opts.paths.length) {
    lines.push("", "## Possible duplicate work", "");
    lines.push(flagged.length ? flagged.map((b) => `- **${b.name}** (${b.status}, ${b.ahead} ahead, ${b.ageDays}d) — read its commits and docs before starting.`).join("\n") : "- none found for this topic/paths");
  }
  lines.push(
    "",
    "## Next steps",
    "",
    "- active: someone is working there — coordinate or build on it, don't start a parallel copy.",
    "- stale: read it, then propose archiving (tag) and deleting it to the owner.",
    "- merged: safe to delete.",
  );
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("usage: node scripts/work-inventory.mjs [--base origin/main] [--no-fetch] [--topic words] [--paths p1 p2 ...] [--json]");
    process.exit(0);
  }
  const inv = collect(opts);
  if (opts.json) console.log(JSON.stringify(inv, (k, v) => (k === "files" ? undefined : v), 2));
  else console.log(render(inv, opts));
}
