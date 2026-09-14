#!/usr/bin/env node
// Runs one OAuth 2.1 authorization-code + PKCE flow against the project's
// Supabase Auth OAuth server, the way ChatGPT and claude.ai will, and prints
// what came back. It exists to prove facts about a BETA server before code
// depends on them, and to test the MCP server end to end afterwards.
//
// It never prints or writes the access token. Claims only.
//
//   node scripts/oauth-spike.mjs            # discovery, register, sign in, claims
//   node scripts/oauth-spike.mjs --mcp      # ...then call tools/list with the token
//
// Needs SUPABASE_URL in the environment (the project URL, not a key).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const base = process.env.SUPABASE_URL;
if (!base) {
  console.error("Set SUPABASE_URL=https://<ref>.supabase.co");
  process.exit(1);
}
const callMcp = process.argv.includes("--mcp");
const PORT = 8976;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

const discoveryUrl = `${base}/.well-known/oauth-authorization-server/auth/v1`;
const discovery = await (await fetch(discoveryUrl)).json();
console.log("issuer:", discovery.issuer);
console.log("authorization_endpoint:", discovery.authorization_endpoint);
console.log("token_endpoint:", discovery.token_endpoint);
console.log("registration_endpoint:", discovery.registration_endpoint);

const reg = await fetch(discovery.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Strength Log OAuth spike",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
const client = await reg.json();
if (!reg.ok) {
  console.error("registration failed:", reg.status, client);
  process.exit(1);
}
console.log("registered client_id:", client.client_id);

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));
const authorize = new URL(discovery.authorization_endpoint);
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
}).toString();

console.log(
  "\nOpen this in a browser and WATCH THE URL BAR after it redirects:",
);
console.log(authorize.toString(), "\n");

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT);
    if (url.pathname !== "/callback") return res.writeHead(404).end();
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("Done. Return to the terminal.");
    server.close();
    if (url.searchParams.get("state") !== state)
      return reject(new Error("state mismatch"));
    const err = url.searchParams.get("error");
    if (err) return reject(new Error(`authorization denied: ${err}`));
    resolve(url.searchParams.get("code"));
  });
  server.listen(PORT, "127.0.0.1");
});

const tokenRes = await fetch(discovery.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok) {
  console.error(
    "token exchange failed:",
    tokenRes.status,
    tokens.error,
    tokens.error_description,
  );
  process.exit(1);
}
const [headerPart, payloadPart] = tokens.access_token.split(".");
const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
console.log("jwt alg:", header.alg);
console.log("claims:", {
  iss: claims.iss,
  aud: claims.aud,
  sub: claims.sub,
  role: claims.role,
  client_id: claims.client_id,
  session_id: claims.session_id,
  lifetime_s: claims.exp - claims.iat,
});
console.log("refresh_token issued:", Boolean(tokens.refresh_token));

// The auth gateway refuses any request without the project's publishable key,
// so without it this check reports 401 for a perfectly good token.
if (process.env.SUPABASE_ANON_KEY) {
  const user = await fetch(`${base}/auth/v1/user`, {
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      apikey: process.env.SUPABASE_ANON_KEY,
    },
  });
  console.log("GET /auth/v1/user with the OAuth token:", user.status);
} else {
  console.log("GET /auth/v1/user: skipped (set SUPABASE_ANON_KEY to run it)");
}

if (callMcp) {
  const mcp = await fetch(`${base}/functions/v1/mcp-server`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await mcp.json();
  console.log(
    "MCP tools/list:",
    mcp.status,
    Array.isArray(body?.result?.tools)
      ? `${body.result.tools.length} tools`
      : body,
  );
}

console.log(
  "\nTo test revocation: disconnect this client in the app (or dashboard),",
);
console.log(
  "then run the /auth/v1/user check again within the token's lifetime.",
);
