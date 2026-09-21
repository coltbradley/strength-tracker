// scripts/release-ledger.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEDGER_STATES,
  STOP_RELEASE_IDS,
  parseLedger,
  validateLedger,
} from "./lib/release-ledger.mjs";

const HEADER = `| ID | Boundary | Owner | State | Regression test | Production proof | Rollback |`;
const DIV = `| --- | --- | --- | --- | --- | --- | --- |`;
const stub = (id) => `| ${id} | x | Engineering | open | — | — | — |`;

test("STOP_RELEASE_IDS covers the audit's stop-release set", () => {
  assert.equal(STOP_RELEASE_IDS[0], "A-01");
  assert.ok(STOP_RELEASE_IDS.includes("A-26"));
  assert.ok(STOP_RELEASE_IDS.includes("A-159"));
  assert.equal(new Set(STOP_RELEASE_IDS).size, STOP_RELEASE_IDS.length);
});

test("parseLedger reads one row", () => {
  const [row] = parseLedger(
    `${HEADER}\n${DIV}\n| A-02 | Coach allowlist | Colt | needs live proof | allowlist.test.ts | secrets list | redeploy |\n`,
  );
  assert.equal(row.id, "A-02");
  assert.equal(row.state, "needs live proof");
  assert.equal(row.owner, "Colt");
});

test("validateLedger reports a missing stop-release id", () => {
  const rows = STOP_RELEASE_IDS.slice(1).map((id) => ({
    id,
    boundary: "x",
    owner: "Engineering",
    state: "open",
    regressionTest: "—",
    productionProof: "—",
    rollback: "—",
  }));
  const errors = validateLedger(rows);
  assert.ok(errors.some((e) => e.includes("A-01") && e.includes("missing")));
});

test("validateLedger rejects an illegal state", () => {
  const rows = STOP_RELEASE_IDS.map((id) => ({
    id,
    boundary: "x",
    owner: "Engineering",
    state: id === "A-01" ? "fixed" : "open",
    regressionTest: "—",
    productionProof: "—",
    rollback: "—",
  }));
  const errors = validateLedger(rows);
  assert.ok(errors.some((e) => e.includes("A-01") && e.includes("state")));
});

test("validateLedger allows extra post-merge rows", () => {
  const markdown = [
    HEADER,
    DIV,
    ...STOP_RELEASE_IDS.map(stub),
    `| A-119 | Coach observations | Engineering | open | — | — | — |`,
  ].join("\n");
  assert.deepEqual(validateLedger(parseLedger(markdown)), []);
});

test("LEDGER_STATES is the Phase 0 closed set", () => {
  assert.deepEqual(
    [...LEDGER_STATES],
    ["open", "fixed with test", "needs live proof", "not reproducible"],
  );
});
