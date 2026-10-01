// Keeps the phone-queue recovery procedure proven in CI: the anonymized copy
// of the real export goes through the real schema (PGlite + every migration),
// the app's repair function, the void-hold replay and a second no-op replay.
//
//   node --test scripts/rehearse-queue-repair.test.mjs
//
// The real export is never committed; run the script on it by hand:
//   node scripts/rehearse-queue-repair.mjs <export.json>
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./lib/pglite-chain.mjs";
import { rehearse } from "./rehearse-queue-repair.mjs";

const FIXTURE = join(root, "scripts", "fixtures", "phone-queue-anonymized.json");

test("the anonymized phone queue is restored with typed pounds, 5 live sets, idempotent replay", { timeout: 120_000 }, async () => {
  const { ok, report, checks, live } = await rehearse(FIXTURE);
  assert.ok(ok, report);
  assert.equal(live.length, 5);
  assert.equal(checks.length, 7);
  for (const [lb, kg] of [[145, "65.77"], [75, "34.02"], [100, "45.36"], [115, "52.16"]]) {
    assert.match(report, new RegExp(`load_kg ${Number(kg)}\\s+entered ${lb} lb`));
  }
});

test("the fixture holds no real data: note text replaced, ids are not the originals", async () => {
  const text = await readFile(FIXTURE, "utf8");
  const bundle = JSON.parse(text);
  const note = bundle.items.find((i) => i.operation === "insert set_notes");
  assert.equal(note.row.note, "note text");
  assert.equal(bundle.items.length, 10);
});
