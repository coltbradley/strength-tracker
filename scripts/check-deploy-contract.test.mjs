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
  const gateStart = text.indexOf("- id: gate");
  const smokeStart = text.indexOf("- name: smoke");
  assert.ok(gateStart >= 0 && smokeStart > gateStart, "gate step must precede smoke");
  const gateSlice = text.slice(gateStart, smokeStart);
  assert.equal(gateSlice.includes('echo "on=false"'), true);
  assert.match(gateSlice, /exit 1/);
  assert.equal(
    /on=false[\s\S]*exit 0/.test(gateSlice),
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

test("pages runs the PWA env checker before vite build", async () => {
  const text = await yaml();
  const pages = text.slice(text.indexOf("name: publish PWA"));
  const checkAt = pages.indexOf("node scripts/check-pwa-env.mjs");
  const buildAt = pages.indexOf("npm run build");
  assert.ok(checkAt >= 0, "missing check-pwa-env.mjs");
  assert.ok(buildAt > checkAt, "env checker must run before npm run build");
});

test("pages smokes the published app and prints a receipt", async () => {
  const text = await yaml();
  const afterPublish = text.slice(text.indexOf("peaceiris/actions-gh-pages"));
  assert.match(afterPublish, /curl /);
  assert.match(afterPublish, /github\.sha/);
  assert.match(afterPublish, /github\.run_id/);
  assert.equal(afterPublish.includes("SUPABASE_ACCESS_TOKEN"), false);
  assert.equal(afterPublish.includes("SUPABASE_DB_PASSWORD"), false);
  assert.equal(afterPublish.includes("SERVICE_ROLE"), false);
});

test("pages smoke reads the served build SHA back, not the one it meant to publish", async () => {
  const text = await yaml();
  const smoke = text.slice(text.indexOf("- name: smoke"));
  assert.match(smoke, /build\.json/, "smoke must fetch the served build stamp");
  assert.match(smoke, /served_sha/, "smoke must compare a served SHA");
  assert.match(smoke, /"\$served_sha" != "\$\{\{ github\.sha \}\}"/, "a mismatch must fail the job");
});

test("the PWA build emits build.json from VITE_BUILD_SHA", async () => {
  const cfg = await readFile(join(root, "pwa/vite.config.ts"), "utf8");
  assert.match(cfg, /fileName: "build\.json"/);
  assert.match(cfg, /VITE_BUILD_SHA/);
});
