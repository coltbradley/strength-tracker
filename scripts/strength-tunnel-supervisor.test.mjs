import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { readKeychainSecret, supervise } from "./strength-tunnel-supervisor.mjs";

test("reads and trims a Keychain secret without logging it", async () => {
  const logs = [];
  const token = await readKeychainSecret({
    service: "Strength Tracker MCP",
    account: "colt",
    logger: (line) => logs.push(line),
    execFile: async () => ({ stdout: "stl_secret\n" }),
  });

  assert.equal(token, "stl_secret");
  assert.equal(logs.join("\n").includes("stl_secret"), false);
});

test("starts the relay before the tunnel and stops both when one exits", async () => {
  const events = [];
  const children = [];
  const controller = new AbortController();
  const spawnImpl = (command) => {
    const role = command === "relay" ? "relay" : "tunnel";
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      events.push(`${role}:stop`);
      child.exitCode = 0;
      child.emit("exit", 0, "SIGTERM");
      return true;
    };
    events.push(`${role}:start`);
    children.push({ role, child });
    return child;
  };

  const running = supervise({
    spawnImpl,
    relayCommand: ["relay"],
    tunnelCommand: ["tunnel"],
    relayEnv: {},
    tunnelEnv: {},
    waitForRelay: async () => events.push("relay:ready"),
    delay: async () => controller.abort(),
    logger: () => {},
    signal: controller.signal,
  });

  await new Promise((resolve) => setImmediate(resolve));
  children.find(({ role }) => role === "tunnel").child.emit("exit", 1, null);
  await running;

  assert.deepEqual(events.slice(0, 3), ["relay:start", "relay:ready", "tunnel:start"]);
  assert.deepEqual(events.filter((event) => event.endsWith(":stop")), ["tunnel:stop", "relay:stop"]);
});
