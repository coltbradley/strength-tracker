#!/usr/bin/env node
// Mint an MCP bearer token for one user.
//
//   node scripts/issue-mcp-token.mjs --user <uuid> --label "Colt · Claude Desktop"
//
// Prints the token ONCE, plus the SQL to paste into the Supabase SQL editor.
// Only the SHA-256 digest is ever stored, so this is the only moment the token
// exists in readable form — there is no "show it again" and no recovery. Losing
// it costs one revoke and one re-issue, which is the trade that makes a
// database leak worthless.
//
// This script deliberately holds NO credentials and makes no network calls: it
// is pure local computation, so it is safe to run anywhere and there is nothing
// in it to leak. The one privileged step (the INSERT) is done by a human in the
// dashboard, where the service key already lives.

import { randomBytes, createHash } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const userId = flag("user");
const label = flag("label");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!userId || !label) {
  console.error(`Usage:
  node scripts/issue-mcp-token.mjs --user <uuid> --label "<who and which client>"

Find the uuid in the Supabase dashboard under Authentication > Users, or:
  select id, email from auth.users order by created_at;

The label is for your own logs — it is printed with every request that token
makes, so make it say WHO and WHICH CLIENT ("Sam · ChatGPT", not "token 2").`);
  process.exit(1);
}

if (!UUID.test(userId)) {
  console.error(`--user '${userId}' is not a uuid. Copy it from auth.users.`);
  process.exit(1);
}

// 32 bytes of CSPRNG entropy. base64url so it survives every header, shell and
// JSON config file without escaping. The prefix makes the string greppable in a
// config directory and obvious in a leak report.
const token = `stl_${randomBytes(32).toString("base64url")}`;
const digest = createHash("sha256").update(token).digest("hex");
const sqlLabel = label.replace(/'/g, "''");

console.log(`
Token (copy it now — it is not stored and cannot be shown again):

  ${token}

Run this in the Supabase SQL editor to activate it:

  insert into mcp_tokens (token_sha256, user_id, label)
  values ('${digest}', '${userId}', '${sqlLabel}');

Claude Desktop / Claude Code — claude_desktop_config.json:

  {
    "mcpServers": {
      "strength-log": {
        "command": "npx",
        "args": [
          "-y", "mcp-remote",
          "https://<project-ref>.supabase.co/functions/v1/mcp-server",
          "--header", "Authorization: Bearer ${token}"
        ]
      }
    }
  }

Any client that takes a URL and an API key (claude.ai custom connectors,
ChatGPT custom connectors, the MCP Inspector) — point it at:

  https://<project-ref>.supabase.co/functions/v1/mcp-server

  header  Authorization: Bearer ${token}
  or      x-api-key: ${token}

To revoke it later (the row stays, so the audit trail survives):

  update mcp_tokens set revoked_at = now() where token_sha256 = '${digest}';
`);
