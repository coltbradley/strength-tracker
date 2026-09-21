import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const yaml = () => readFile(join(root, ".github/workflows/deploy.yml"), "utf8");

test("deploy does not wait on CI", async () => {
  const text = await yaml();
  assert.equal(text.includes("workflow_run"), false);
  assert.match(text, /^on:\n  push:\n    branches: \[main\]/m);
  assert.equal(/\n\s+needs:.*\bci\b/.test(text), false);
});

test("a supabase-path push with missing secrets fails the supabase job", async () => {
  const text = await yaml();
  assert.match(text, /if: needs\.changes\.outputs\.supabase == 'true'/);
  assert.match(text, /exit 1/);
  assert.equal(text.includes('echo "on=false"'), true);
  assert.equal(
    /on=false[\s\S]*exit 0/.test(text),
    false,
    "missing secrets must not skip-success",
  );
});

test("pages still waits on a failed supabase job and proceeds when it is skipped", async () => {
  const text = await yaml();
  assert.match(text, /needs: \[changes, supabase\]/);
  assert.match(text, /needs\.supabase\.result != 'failure'/);
  assert.match(text, /always\(\)/);
});
