import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("tracked tunnel configuration contains no plaintext secrets", async () => {
  for (const path of [
    "scripts/strength-tunnel-client.yaml.example",
    "scripts/com.strength-tracker.mcp-tunnel.plist.template",
  ]) {
    const text = await readFile(path, "utf8");
    assert.equal(text.includes("stl_"), false, `${path} contains a Strength Tracker bearer-looking value`);
    assert.equal(text.includes("STRENGTH_MCP_TOKEN"), false, `${path} accepts a plaintext Strength Tracker token`);
    assert.equal(text.includes("CONTROL_PLANE_API_KEY="), false, `${path} contains an OpenAI runtime key assignment`);
  }
});

test("the tunnel profile targets the local relay and resolves its runtime key from the environment", async () => {
  const profile = await readFile("scripts/strength-tunnel-client.yaml.example", "utf8");
  assert.match(profile, /url: "http:\/\/127\.0\.0\.1:8786\/mcp"/);
  assert.match(profile, /api_key: "env:CONTROL_PLANE_API_KEY"/);
  assert.match(profile, /tunnel_id: "tunnel_REPLACE_ME"/);
});
