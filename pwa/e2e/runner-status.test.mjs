import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/run-phase2-e2e.mjs", import.meta.url));

function run(env) {
  return spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

test("missing local configuration reports NOT RUN with a nonzero status", () => {
  const result = run({});
  assert.equal(result.status, 3);
  assert.match(result.stdout, /^NOT RUN:/);
});

test("hosted Supabase URL is refused with a distinct status before admin-key loading", () => {
  const result = run({
    PHASE2_SUPABASE_URL: "https://hosted.supabase.co",
    PHASE2_ANON_KEY: "test-anon-key",
    PHASE2_APP_URL: "http://127.0.0.1:5198",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /hosted targets are refused/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /service role key/);
});
