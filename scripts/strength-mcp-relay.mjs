#!/usr/bin/env node

import http from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
];
const RESPONSE_HEADERS = ["cache-control", "content-type", "mcp-session-id"];
// The only legitimate caller is tunnel-client, a local process. A browser is
// never one, and the relay attaches a real bearer to whatever it forwards, so
// any page open on this Mac that could reach 127.0.0.1 would otherwise get the
// owner's full MCP access. So: no CORS headers at all, anything carrying an
// Origin (every browser sends one on a cross-origin POST) is refused, and the
// Host must be a loopback name, which a DNS-rebound hostname is not.
// Sec-Fetch-* is deliberately not checked: Node's own fetch sends it.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;

class BodyTooLarge extends Error {}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export function isBrowserOrForeignRequest(headers) {
  if (headers.origin !== undefined) return true;
  const host = headers.host;
  if (typeof host !== "string") return true;
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return !LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function textResponse(response, status, message, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify({ error: message }));
}

export function validateRelayConfig({ upstreamUrl, token }) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("STRENGTH_MCP_TOKEN is required");
  }
  let parsed;
  try {
    parsed = new URL(upstreamUrl);
  } catch {
    throw new Error("STRENGTH_MCP_URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("STRENGTH_MCP_URL must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("STRENGTH_MCP_URL cannot contain credentials or a fragment");
  }
  if (parsed.pathname !== "/mcp") {
    throw new Error("STRENGTH_MCP_URL must point exactly to /mcp");
  }
  if (parsed.search) {
    throw new Error("STRENGTH_MCP_URL cannot contain query parameters");
  }
  return parsed;
}

function forwardHeaders(request) {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

function responseHeaders(upstream) {
  const headers = {};
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

export function createRelayServer({ upstreamUrl, token, logger = () => {}, fetchImpl = fetch }) {
  const upstream = validateRelayConfig({ upstreamUrl, token });

  return http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (isBrowserOrForeignRequest(request.headers)) {
      logger({ event: "relay_refused", reason: "browser_or_foreign_host", duration_ms: Date.now() - startedAt });
      return textResponse(response, 403, "forbidden");
    }
    if (path !== "/mcp") return textResponse(response, 404, "not found");
    if (request.method !== "POST") {
      return textResponse(response, 405, "method not allowed", { allow: "POST" });
    }

    let body;
    try {
      body = await requestBody(request);
    } catch (error) {
      if (error instanceof BodyTooLarge) return textResponse(response, 413, "request too large", { connection: "close" });
      return textResponse(response, 400, "bad request");
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
    try {
      const headers = forwardHeaders(request);
      headers.set("authorization", `Bearer ${token}`);
      const upstreamResponse = await fetchImpl(upstream.href, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: abort.signal,
      });
      // the timeout bounds the wait for headers only; an SSE body may stream
      clearTimeout(timer);
      response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
      if (!upstreamResponse.body) {
        response.end();
      } else {
        Readable.fromWeb(upstreamResponse.body).on("error", () => response.destroy()).pipe(response);
      }
      logger({ event: "relay_request", method: "POST", status: upstreamResponse.status, duration_ms: Date.now() - startedAt });
    } catch {
      clearTimeout(timer);
      logger({ event: "relay_request", method: "POST", status: 502, duration_ms: Date.now() - startedAt });
      if (!response.headersSent) textResponse(response, 502, "upstream unavailable");
      else response.destroy();
    }
  });
}

function env(name, fallback) {
  return process.env[name] ?? fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(env("STRENGTH_MCP_RELAY_PORT", "8786"));
  const server = createRelayServer({
    upstreamUrl: env("STRENGTH_MCP_URL"),
    token: env("STRENGTH_MCP_TOKEN"),
    logger: (event) => console.error(JSON.stringify(event)),
  });
  server.listen(port, "127.0.0.1", () => {
    console.error(JSON.stringify({ event: "relay_ready", address: `127.0.0.1:${port}` }));
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
