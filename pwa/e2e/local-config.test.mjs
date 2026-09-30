import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLoopbackUrl, loadLocalConfig } from "./local-config.mjs";

test("accepts local Supabase endpoints used by the disposable stack", () => {
  assert.equal(assertLoopbackUrl("http://127.0.0.1:54321"), "http://127.0.0.1:54321");
  assert.equal(assertLoopbackUrl("http://localhost:54321"), "http://localhost:54321");
  assert.equal(assertLoopbackUrl("http://[::1]:54321"), "http://[::1]:54321");
});

test("rejects hosted Supabase endpoints before any test user can be created", () => {
  assert.throws(
    () => assertLoopbackUrl("https://idjjdmtgchcpwqmtkoza.supabase.co"),
    /loopback/,
  );
});

test("rejects URL credentials and non-HTTP protocols", () => {
  assert.throws(() => assertLoopbackUrl("http://key@127.0.0.1:54321"), /credentials/);
  assert.throws(() => assertLoopbackUrl("https://127.0.0.1:54321"), /http/);
});

test("reads the local admin key only from its separate fixture file after URL validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase2-e2e-config-"));
  try {
    const envFile = join(dir, ".env.e2e.local");
    const adminEnvFile = join(dir, ".env.e2e.admin.local");
    await writeFile(envFile, "PHASE2_SUPABASE_URL=http://127.0.0.1:54321\nPHASE2_ANON_KEY=local-public-key\n");
    await writeFile(adminEnvFile, "PHASE2_SERVICE_ROLE_KEY=local-only-test-key\n");
    const config = await loadLocalConfig({ env: {}, envFile, adminEnvFile });
    assert.equal(config.supabaseUrl, "http://127.0.0.1:54321");
    assert.equal(config.anonKey, "local-public-key");
    assert.equal(config.serviceRoleKey, "local-only-test-key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects hosted targets while loading test configuration", async () => {
  await assert.rejects(
    loadLocalConfig({
      env: {
        PHASE2_SUPABASE_URL: "https://project.supabase.co",
        PHASE2_ANON_KEY: "key",
      },
      envFile: "/tmp/nonexistent-phase2-e2e.env",
      adminEnvFile: "/path-that-must-not-be-read-before-url-validation",
    }),
    /loopback/,
  );
});
