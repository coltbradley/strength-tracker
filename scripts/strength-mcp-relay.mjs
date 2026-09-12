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
const CORS_HEADERS = {
  "access-control-allow-headers": "accept, authorization, content-type, mcp-protocol-version, mcp-session-id, x-api-key",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-origin": "*",
};

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function textResponse(response, status, message, headers = {}) {
  response.writeHead(status, {
    ...CORS_HEADERS,
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
  const headers = { ...CORS_HEADERS };
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
    if (path !== "/mcp") return textResponse(response, 404, "not found");
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      return textResponse(response, 405, "method not allowed", { allow: "POST, OPTIONS" });
    }

    try {
      const headers = forwardHeaders(request);
      headers.set("authorization", `Bearer ${token}`);
      const upstreamResponse = await fetchImpl(upstream.href, {
        method: "POST",
        headers,
        body: await requestBody(request),
        redirect: "error",
      });
      response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
      if (!upstreamResponse.body) {
        response.end();
      } else {
        Readable.fromWeb(upstreamResponse.body).on("error", () => response.destroy()).pipe(response);
      }
      logger({ event: "relay_request", method: "POST", status: upstreamResponse.status, duration_ms: Date.now() - startedAt });
    } catch {
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
