// One MCP tool call, for a driver that is not this process (a subagent over
// curl, or a person at a prompt). Needs serve.mjs running.
//
//   node tool.mjs get_program '{}'
//   node tool.mjs remember '{"kind":"preference","fact":"Dislikes calf raises"}'
//
// Prints the tool result text, or the error, and exits non-zero on failure.

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [name, rawArgs = "{}"] = process.argv.slice(2);

if (!name) {
  console.error("usage: node tool.mjs <tool_name> '<json arguments>'");
  process.exit(2);
}

let args;
try {
  args = JSON.parse(rawArgs);
} catch (e) {
  console.error(`arguments are not valid JSON: ${e.message}`);
  process.exit(2);
}

let token;
try {
  token = (await readFile(join(here, "out", "agent", "mcp-token.txt"), "utf8")).trim();
} catch {
  console.error("no token file; is serve.mjs running?");
  process.exit(2);
}

const res = await fetch("http://127.0.0.1:8000/", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  console.error(`non-JSON response (${res.status}): ${text.slice(0, 400)}`);
  process.exit(1);
}

if (body.error) {
  console.error(`tool error: ${JSON.stringify(body.error)}`);
  process.exit(1);
}

const out = (body.result?.content ?? []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
console.log(out);
if (body.result?.isError) process.exit(1);
