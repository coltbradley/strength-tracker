import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";

import { createRelayServer, validateRelayConfig } from "./strength-mcp-relay.mjs";
import { waitForRelay } from "./strength-tunnel-supervisor.mjs";

async function startRelay(options = {}) {
  const server = createRelayServer({
    upstreamUrl: "https://strength.example.test/mcp",
    token: "stored-token",
    logger: () => {},
    fetchImpl: async () => new Response('{"jsonrpc":"2.0","result":{}}'),
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async stop() {
      server.close();
      await once(server, "close");
    },
  };
}

test("replaces caller credentials with the configured bearer", async () => {
  let capturedUrl;
  let capturedInit;
  const relay = await startRelay({
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response('{"jsonrpc":"2.0","result":{}}', {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" },
      });
    },
  });
  try {
    const response = await fetch(relay.url, {
      method: "POST",
      headers: {
        authorization: "Bearer caller-token",
        "x-api-key": "caller-api-key",
        "content-type": "application/json",
      },
      body: '{"jsonrpc":"2.0","method":"tools/list"}',
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, "https://strength.example.test/mcp");
    assert.equal(capturedInit.headers.get("authorization"), "Bearer stored-token");
    assert.equal(capturedInit.headers.get("x-api-key"), null);
    assert.equal(capturedInit.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("mcp-session-id"), "upstream-session");
    assert.equal(await response.text(), '{"jsonrpc":"2.0","result":{}}');
  } finally {
    await relay.stop();
  }
});

test("OPTIONS /mcp is 204 so the supervisor readiness check can succeed", async () => {
  const relay = await startRelay();
  try {
    const response = await fetch(relay.url, { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("allow"), "POST");
    await waitForRelay({ url: relay.url, attempts: 3, delay: async () => {} });
  } finally {
    await relay.stop();
  }
});

test("rejects non-MCP routes and unsupported methods", async () => {
  const relay = await startRelay();
  try {
    assert.equal((await fetch(`${relay.url}/wrong`, { method: "POST" })).status, 404);
    const response = await fetch(relay.url, { method: "GET" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  } finally {
    await relay.stop();
  }
});

test("refuses browser requests and non-loopback hosts without reaching the upstream", async () => {
  let called = false;
  const relay = await startRelay({ fetchImpl: async () => { called = true; return new Response("{}"); } });
  const { port } = new URL(relay.url);
  const post = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
      res.resume();
      resolve(res);
    });
    req.on("error", reject);
    req.end("{}");
  });
  try {
    const cases = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { host: `evil.example:${port}` },
    ];
    for (const headers of cases) {
      const response = await post(headers);
      assert.equal(response.statusCode, 403, JSON.stringify(headers));
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
    const preflight = await fetch(relay.url, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    assert.equal(called, false);
  } finally {
    await relay.stop();
  }
});

test("refuses an oversized body", async () => {
  let called = false;
  const relay = await startRelay({ fetchImpl: async () => { called = true; return new Response("{}"); } });
  try {
    const response = await fetch(relay.url, { method: "POST", body: "x".repeat(4 * 1024 * 1024 + 1) }).catch(() => null);
    if (response) assert.equal(response.status, 413);
    assert.equal(called, false);
  } finally {
    await relay.stop();
  }
});

test("fails closed for an HTTP upstream and an upstream redirect", async () => {
  assert.throws(
    () => validateRelayConfig({ upstreamUrl: "http://127.0.0.1/mcp", token: "stored-token" }),
    /HTTPS/,
  );
  const relay = await startRelay({
    fetchImpl: async () => {
      throw new TypeError("unexpected redirect");
    },
  });
  try {
    assert.equal((await fetch(relay.url, { method: "POST", body: "{}" })).status, 502);
  } finally {
    await relay.stop();
  }
});
