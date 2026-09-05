// The local stack the eval runs against: the REAL MCP server (Deno) talking
// to PostgREST talking to PGlite over a socket. No Docker, no production.
//
//   PGlite (migrations + seed + fixture)
//     └─ pglite-socket :54329
//          └─ PostgREST :54330            (binary: $POSTGREST or ../../.bin/postgrest)
//               └─ proxy :54321  strips /rest/v1 so supabase-js is none the wiser
//                    └─ deno run supabase/functions/mcp-server :8000
//
// Auth into the MCP server uses its legacy env path (MCP_SECRET + OWNER_USER_ID)
// so the fixture needs no mcp_tokens row.

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..", "..");

const PORTS = { pg: 54329, postgrest: 54330, proxy: 54321, mcp: 8000 };

// Generated per run, never hardcoded. These authenticate a throwaway
// in-memory database to itself for the life of one process: PostgREST
// verifies the JWT it is handed, and the MCP server matches the bearer
// against its legacy env path. Neither is a credential for anything real.
const JWT_SECRET = randomUUID() + randomUUID();
export const MCP_SECRET = randomUUID();

function b64url(s) {
  return Buffer.from(s).toString("base64url");
}
function serviceJwt() {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(
    JSON.stringify({ role: "service_role", iss: "supabase", exp: 4102444800 }),
  );
  const sig = createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

async function waitFor(url, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not come up at ${url}`);
}

/** Every `lib` directory under .bin/lib, joined for DYLD_LIBRARY_PATH. */
async function discoverLibs() {
  const base = join(root, ".bin", "lib");
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "lib") found.push(join(dir, e.name));
      else await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(base, 0);
  if (found.length === 0) return null;
  return [...found, "/opt/homebrew/opt/openssl@3/lib"].join(":");
}

export async function createDb() {
  const db = await PGlite.create();
  // Same shim validate-db.mjs uses, plus the service role PostgREST will SET ROLE into.
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
    create role authenticated login;
    create role anon login;
    create role service_role nologin bypassrls;
  `);
  const migDir = join(root, "supabase", "migrations");
  const migrations = (await readdir(migDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const m of migrations) await db.exec(await readFile(join(migDir, m), "utf8"));
  await db.exec(`
    grant usage on schema public, auth to authenticated, anon, service_role;
    grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
    grant usage, select on all sequences in schema public to authenticated, service_role;
    grant execute on all functions in schema public to authenticated, anon, service_role;
    grant execute on all functions in schema auth to authenticated, anon, service_role;
  `);
  for (const seed of ["exercises.generated.sql", "exercises.curated.sql"]) {
    await db.exec(await readFile(join(root, "supabase", "seed", seed), "utf8"));
  }
  return db;
}

export async function startStack({ ownerId, log = () => {} }) {
  const db = await createDb();
  const socket = new PGLiteSocketServer({ db, port: PORTS.pg, host: "127.0.0.1" });
  await socket.start();
  log(`pglite socket on :${PORTS.pg}`);

  const bin = process.env.POSTGREST ?? join(root, ".bin", "postgrest");
  const conf = `
db-uri = "postgres://postgres:postgres@127.0.0.1:${PORTS.pg}/postgres"
db-schemas = "public"
db-anon-role = "anon"
db-pool = 1
db-channel-enabled = false
db-config = false
db-prepared-statements = false
server-host = "127.0.0.1"
server-port = ${PORTS.postgrest}
log-level = "error"
`;
  const confPath = join(here, ".postgrest.conf");
  await (await import("node:fs/promises")).writeFile(confPath, conf);
  // The signing key goes in the environment, not the config file: PostgREST
  // reads PGRST_* for anything the file does not set, and this way the key
  // never touches disk.
  //
  // The binary dynamically links libpq and krb5. If they are not installed
  // system-wide, the README's fallback drops the bottles under .bin/lib and
  // this finds them; POSTGREST_DYLD overrides.
  const dyld = process.env.POSTGREST_DYLD ?? (await discoverLibs());
  const postgrest = spawn(bin, [confPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PGRST_JWT_SECRET: JWT_SECRET,
      ...(dyld ? { DYLD_LIBRARY_PATH: dyld } : {}),
    },
  });
  postgrest.stderr.on("data", (d) => log(`postgrest: ${String(d).trim()}`));
  postgrest.stdout.on("data", (d) => log(`postgrest: ${String(d).trim()}`));
  await waitFor(`http://127.0.0.1:${PORTS.postgrest}/`, "postgrest");
  log(`postgrest on :${PORTS.postgrest}`);

  // supabase-js talks to `${url}/rest/v1/...`; PostgREST serves at `/`.
  const proxy = http.createServer((req, res) => {
    if (!req.url.startsWith("/rest/v1")) {
      res.writeHead(404).end("only /rest/v1 is proxied");
      return;
    }
    const up = http.request(
      {
        host: "127.0.0.1",
        port: PORTS.postgrest,
        method: req.method,
        path: req.url.slice("/rest/v1".length) || "/",
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 500, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", (e) => res.writeHead(502).end(String(e)));
    req.pipe(up);
  });
  await new Promise((r) => proxy.listen(PORTS.proxy, "127.0.0.1", r));
  log(`proxy on :${PORTS.proxy}`);

  const mcpDir = join(root, "supabase", "functions", "mcp-server");
  const mcp = spawn(
    "deno",
    ["run", "-A", "--config", join(mcpDir, "deno.json"), "--lock", join(mcpDir, "deno.lock"), join(mcpDir, "index.ts")],
    {
      env: {
        ...process.env,
        SUPABASE_URL: `http://127.0.0.1:${PORTS.proxy}`,
        SUPABASE_SERVICE_ROLE_KEY: serviceJwt(),
        MCP_SECRET,
        OWNER_USER_ID: ownerId,
        LOG_LEVEL: "error",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  mcp.stdout.on("data", (d) => log(`mcp: ${String(d).trim()}`));
  mcp.stderr.on("data", (d) => log(`mcp: ${String(d).trim()}`));
  await waitFor(`http://127.0.0.1:${PORTS.mcp}/health`, "mcp-server");
  log(`mcp-server on :${PORTS.mcp}`);

  const mcpUrl = `http://127.0.0.1:${PORTS.mcp}/`;

  async function rpc(method, params) {
    const r = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${MCP_SECRET}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`mcp ${method}: non-JSON ${r.status}: ${text.slice(0, 200)}`);
    }
    if (body.error) throw new Error(`mcp ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  return {
    db,
    rpc,
    /** MCP tools as Anthropic client tools (the connector would present the same schemas). */
    async tools(exclude = ["delete_program", "delete_exercise"]) {
      const r = await rpc("tools/list", {});
      return r.tools
        .filter((t) => !exclude.includes(t.name))
        .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    },
    async call(name, args) {
      const r = await rpc("tools/call", { name, arguments: args });
      const text = (r.content ?? []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
      return { text, isError: Boolean(r.isError) };
    },
    async stop() {
      mcp.kill();
      proxy.close();
      postgrest.kill();
      await socket.stop();
      await db.close();
    },
  };
}
