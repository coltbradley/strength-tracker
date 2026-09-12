#!/usr/bin/env node

import { spawn } from "node:child_process";
import { execFile as execFileCallback } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 30_000];

export async function readKeychainSecret({ service, account, execFile: run = execFile, logger = () => {} }) {
  logger({ event: "keychain_read", service, account });
  const { stdout } = await run("/usr/bin/security", [
    "find-generic-password",
    "-s",
    service,
    "-a",
    account,
    "-w",
  ]);
  const secret = String(stdout).trim();
  if (!secret) throw new Error(`Keychain item ${service}/${account} is empty`);
  return secret;
}

function childExit(child, role) {
  return new Promise((resolve) => {
    child.once("error", () => resolve({ role, reason: "error" }));
    child.once("exit", () => resolve({ role, reason: "exit" }));
  });
}

function stop(child) {
  if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
}

function abortSignal(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve({ role: "supervisor", reason: "aborted" });
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ role: "supervisor", reason: "aborted" }), { once: true }));
}

export async function waitForRelay({ url, fetchImpl = fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 30 }) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { method: "OPTIONS" });
      if (response.status === 204) {
        await response.body?.cancel();
        return;
      }
      lastError = new Error(`relay returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`relay did not become ready: ${lastError?.message ?? "unknown error"}`);
}

export async function supervise({
  spawnImpl = spawn,
  relayCommand,
  tunnelCommand,
  relayEnv,
  tunnelEnv,
  waitForRelay: ready = async () => {},
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = () => {},
  signal,
}) {
  let attempt = 0;
  while (!signal?.aborted) {
    let relay;
    let tunnel;
    try {
      relay = spawnImpl(relayCommand[0], relayCommand.slice(1), { env: relayEnv, stdio: ["ignore", "ignore", "pipe"] });
      logger({ event: "relay_started" });
      await ready();
      if (signal?.aborted) break;
      tunnel = spawnImpl(tunnelCommand[0], tunnelCommand.slice(1), { env: tunnelEnv, stdio: ["ignore", "ignore", "pipe"] });
      logger({ event: "tunnel_started" });
      const outcome = await Promise.race([childExit(relay, "relay"), childExit(tunnel, "tunnel"), abortSignal(signal)]);
      if (outcome.reason !== "aborted") logger({ event: "child_exited", role: outcome.role });
    } finally {
      stop(tunnel);
      stop(relay);
    }
    if (signal?.aborted) break;
    const waitMs = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    logger({ event: "restart_wait", delay_ms: waitMs });
    attempt += 1;
    await delay(waitMs);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const account = process.env.STRENGTH_MCP_KEYCHAIN_ACCOUNT ?? "strength-tracker";
  const strengthToken = await readKeychainSecret({
    service: process.env.STRENGTH_MCP_KEYCHAIN_SERVICE ?? "Strength Tracker MCP",
    account,
  });
  const runtimeKey = await readKeychainSecret({
    service: process.env.OPENAI_TUNNEL_KEYCHAIN_SERVICE ?? "OpenAI Tunnel Runtime",
    account: process.env.OPENAI_TUNNEL_KEYCHAIN_ACCOUNT ?? account,
  });
  const port = process.env.STRENGTH_MCP_RELAY_PORT ?? "8786";
  const here = dirname(fileURLToPath(import.meta.url));
  const controller = new AbortController();
  for (const event of ["SIGINT", "SIGTERM"]) process.on(event, () => controller.abort());

  await supervise({
    relayCommand: [process.execPath, join(here, "strength-mcp-relay.mjs")],
    tunnelCommand: [process.env.TUNNEL_CLIENT_BIN ?? "tunnel-client", "run", "--profile", process.env.TUNNEL_PROFILE ?? "strength-tracker"],
    relayEnv: {
      PATH: process.env.PATH ?? "",
      STRENGTH_MCP_RELAY_PORT: port,
      STRENGTH_MCP_TOKEN: strengthToken,
      STRENGTH_MCP_URL: required("STRENGTH_MCP_URL"),
    },
    tunnelEnv: {
      CONTROL_PLANE_API_KEY: runtimeKey,
      HOME: required("HOME"),
      PATH: process.env.PATH ?? "",
    },
    waitForRelay: () => waitForRelay({ url: `http://127.0.0.1:${port}/mcp` }),
    logger: (event) => console.error(JSON.stringify(event)),
    signal: controller.signal,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "supervisor_failed", error: error.message }));
    process.exit(1);
  });
}
