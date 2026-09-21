import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePwaEnv } from "./check-pwa-env.mjs";

const VALID_URL = "https://abcdefghijklmnop.supabase.co";
const VALID_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

test("missing URL fails and names the var, not a value", () => {
  const r = validatePwaEnv({ VITE_SUPABASE_ANON_KEY: VALID_KEY });
  assert.equal(r.ok, false);
  assert.match(r.message, /VITE_SUPABASE_URL/);
  assert.equal(r.message.includes(VALID_KEY), false);
});

test("http URL fails", () => {
  const r = validatePwaEnv({
    VITE_SUPABASE_URL: "http://abcdefghijklmnop.supabase.co",
    VITE_SUPABASE_ANON_KEY: VALID_KEY,
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /VITE_SUPABASE_URL/);
});

test("placeholder host fails even though it is https supabase.co", () => {
  const r = validatePwaEnv({
    VITE_SUPABASE_URL: "https://placeholder.supabase.co",
    VITE_SUPABASE_ANON_KEY: VALID_KEY,
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /VITE_SUPABASE_URL/);
  assert.equal(r.message.includes("placeholder.supabase.co"), false);
});

test("short anon key fails and does not echo it", () => {
  const r = validatePwaEnv({
    VITE_SUPABASE_URL: VALID_URL,
    VITE_SUPABASE_ANON_KEY: "placeholder-anon-key",
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /VITE_SUPABASE_ANON_KEY/);
  assert.equal(r.message.includes("placeholder-anon-key"), false);
});

test("valid pair passes", () => {
  const r = validatePwaEnv({
    VITE_SUPABASE_URL: VALID_URL,
    VITE_SUPABASE_ANON_KEY: VALID_KEY,
  });
  assert.deepEqual(r, { ok: true });
});
