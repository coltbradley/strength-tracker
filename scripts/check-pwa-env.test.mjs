import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePwaEnv } from "./check-pwa-env.mjs";

const VALID_URL = "https://abcdefghijklmnop.supabase.co";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.c2ln`;
const VALID_KEY = jwt({ iss: "supabase", ref: "abcdefghijklmnop", role: "anon" });

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

test("INFRA-3: a service_role JWT is rejected and never echoed", () => {
  const key = jwt({ role: "service_role" });
  const r = validatePwaEnv({ VITE_SUPABASE_URL: VALID_URL, VITE_SUPABASE_ANON_KEY: key });
  assert.equal(r.ok, false);
  assert.match(r.message, /VITE_SUPABASE_ANON_KEY/);
  assert.equal(r.message.includes(key), false);
});

test("INFRA-3: a JWT with no role, or an undecodable payload, is rejected", () => {
  for (const key of [jwt({ sub: "x" }), "aaa.!!!.ccc", "aaa.bnVsbA.ccc"]) {
    const r = validatePwaEnv({ VITE_SUPABASE_URL: VALID_URL, VITE_SUPABASE_ANON_KEY: key });
    assert.equal(r.ok, false, key);
  }
});

test("INFRA-3: sb_publishable_ keys pass, sb_secret_ keys fail", () => {
  assert.deepEqual(
    validatePwaEnv({ VITE_SUPABASE_URL: VALID_URL, VITE_SUPABASE_ANON_KEY: "sb_publishable_abc123_XYZ" }),
    { ok: true },
  );
  const r = validatePwaEnv({ VITE_SUPABASE_URL: VALID_URL, VITE_SUPABASE_ANON_KEY: "sb_secret_abc123" });
  assert.equal(r.ok, false);
  assert.equal(r.message.includes("sb_secret_abc123"), false);
});
