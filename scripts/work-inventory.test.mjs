import { test } from "node:test";
import assert from "node:assert/strict";
import {
  absoluteSymlinks,
  classifyBranch,
  matchesTopic,
  overlappingPaths,
  STALE_DAYS,
} from "./work-inventory.mjs";

test("classifies base, merged, active and stale branches", () => {
  const base = "origin/main";
  assert.equal(classifyBranch({ name: base, base, ahead: 0, ageDays: 0 }), "base");
  assert.equal(classifyBranch({ name: "origin/x", base, ahead: 0, ageDays: 400 }), "merged");
  assert.equal(classifyBranch({ name: "origin/x", base, ahead: 3, ageDays: 1 }), "active");
  assert.equal(classifyBranch({ name: "origin/x", base, ahead: 3, ageDays: STALE_DAYS + 1 }), "stale");
  assert.equal(classifyBranch({ name: "origin/x", base, ahead: 3, ageDays: STALE_DAYS }), "active");
  assert.equal(classifyBranch({ name: "origin/gh-pages", base, ahead: 60, ageDays: 0 }), "deploy");
});

test("finds paths two branches both change", () => {
  assert.deepEqual(
    overlappingPaths(["pwa/src/screens/Session.tsx", "docs/a.md"], ["docs/a.md", "pwa/src/screens/Session.tsx", "x"]),
    ["docs/a.md", "pwa/src/screens/Session.tsx"],
  );
  assert.deepEqual(overlappingPaths([], ["a"]), []);
});

test("matches a topic against the branch name or its commit subjects, word by word", () => {
  // the case that motivated the script: the same design, two branch names
  assert.equal(matchesTopic("version d", "origin/codex/version-d-light-plan", []), true);
  assert.equal(matchesTopic("Version D", "origin/feat/live-workout-d", ["docs: Version D spec"]), true);
  assert.equal(matchesTopic("dark mode", "origin/feat/train-d", ["feat(train): week strip"]), false);
  assert.equal(matchesTopic(null, "origin/anything", []), false);
});

test("flags tracked symlinks with absolute targets only", () => {
  const ls = [
    "100644 blob aaa\tREADME.md",
    "120000 blob bbb\tpwa/node_modules",
    "120000 blob ccc\tdocs/link",
  ].join("\n");
  const targets = { "pwa/node_modules": "/home/claude/other/pwa/node_modules", "docs/link": "../README.md" };
  assert.deepEqual(absoluteSymlinks(ls, (p) => targets[p]), ["pwa/node_modules"]);
});
