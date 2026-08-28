# Security model

This is a small multi-user system (a household) published as open source. The
repo must be safe
to publish: nothing in it is secret, and the design assumes the code is
public. Security lives in the deployment, not in obscurity.

## What is secret (and lives only in deployment)

| Secret                      | Where it lives                                            | Blast radius if leaked                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP bearer tokens           | `mcp_tokens` (SHA-256 digest only) + each client's config | Full MCP tool surface FOR ONE USER: read their training data, write their programs/TMs/goals. Cannot touch `sessions`/`sets` (no tool exists), and cannot reach another user's rows. Only the digest is stored, so a database leak yields no working credential. Revoke with `update mcp_tokens set revoked_at = now()`; re-issue with `scripts/issue-mcp-token.mjs`. |
| `MCP_SECRET` (legacy)       | Edge function secret                                      | The pre-multi-user single credential, mapped to `OWNER_USER_ID`. Still accepted so an existing client config survives the upgrade. Unset both once per-user tokens are issued.                                                                                                                                                                                        |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge runtime only (platform-injected)                     | Full database. Never in the repo, never in the PWA, never logged.                                                                                                                                                                                                                                                                                                     |
| `OWNER_USER_ID` (legacy)    | Edge function secret                                      | The user `MCP_SECRET` maps to. Not sensitive alone (it's a uuid), but treated as config, not code.                                                                                                                                                                                                                                                                    |
| Supabase anon key + URL     | PWA build env                                             | Public by design. Safe because RLS is the enforcement layer, not the key.                                                                                                                                                                                                                                                                                             |

The repo contains no project refs, user ids, emails, or tokens. `.env*` and
the generated seed are gitignored; `.env.example` documents shape only.

## Layered enforcement, in order of trust

1. **RLS is the floor.** Every table has row level security with
   deny-by-default policies. The PWA runs as an authenticated Supabase Auth
   user; even a fully compromised client can only act as that user, and
   cannot update or delete `sets` at all because those policies simply do
   not exist. Append-only is a database property, not app discipline.
2. **Views are `security_invoker`.** Derived metrics run with the caller's
   permissions, so RLS applies through every view. A view added without
   `security_invoker = true` would silently become a definer-rights hole;
   treat that as a review blocker.
3. **The MCP path uses the service role, deliberately constrained.** MCP
   requests carry a static bearer token, not a user session, so `auth.uid()`
   is null on that path and RLS cannot scope it. Instead: the token IS the
   identity — it is hashed and looked up in `mcp_tokens` to resolve a user —
   the service client is constructed in exactly one module, every query
   stamps/filters that resolved `db.ownerId`, and the tool surface is the
   authorization boundary. There are no tools that write `sessions` or
   `sets`, so the training record is unreachable from MCP by construction.
   The identity is resolved PER REQUEST and never cached: edge isolates are
   reused across callers, so a cached owner id would be a cross-user leak.
   The tradeoff (service role behind a bearer check vs. running a full
   OAuth 2.1 server) is argued in decisions.md.
4. **Auth check before parsing.** The edge function rejects unauthenticated
   requests before touching the request body, with a constant-time
   comparison (hash both sides, `timingSafeEqual`) so token checking leaks
   no timing signal.
5. **Programs require human confirmation.** `upsert_program` always lands
   `confirmed_at = NULL`; a separate `confirm_program` call is required and
   its tool description instructs the model to obtain explicit user approval
   in chat first. A hallucinated or prompt-injected parse cannot become the
   active program silently, and the PWA only surfaces confirmed programs.

## Threats considered

- **Stolen bearer token**: worst realistic case. Attacker reads ONE user's
  training data and writes junk programs (unconfirmed) / TMs / goals for that
  user. Training history is untouchable, and other users are unreachable —
  the blast radius is one person, which is the main thing per-user tokens
  buy over the old shared secret. Mitigation: 32 bytes of CSPRNG entropy,
  HTTPS only, digest-only storage, and revocation is one SQL statement.
- **One household member reading another's log**: the same RLS that isolates
  strangers isolates them, and it is exercised directly in
  `scripts/validate-db.mjs`. The places it does NOT apply are the ones to
  watch: the service-role MCP path (scoped in code, see above) and the
  device cache, which is claimed by one user id and cleared when that
  changes.
- **Public endpoint scanning**: the function URL is guessable. Everything
  401s without the token; no information is returned before auth.
- **Prompt injection via coach screenshot**: a malicious image could try to
  steer the model into writing a bad program. The confirm step plus
  render-back-as-table is the mitigation; writes to the training record are
  impossible regardless.
- **Compromised PWA host / XSS**: the anon key + a phished session gets RLS
  scope only: read own data, append sets. No deletes, no history rewrites.
- **Denial of service**: out of scope; Supabase platform limits apply and
  the data is backed up by the platform.

## Rules for contributors (and future me)

- Never commit env files, project refs, user uuids, or dashboard URLs.
- Never log the Authorization header or request bodies containing it.
- New MCP tools that write must land in decisions.md with a blast-radius
  argument; tools that write `sessions` or `sets` are rejected on principle.
- Do not add update/delete RLS policies to `sets`, or a delete policy to
  `sessions`, without a decisions.md entry explaining why the append-only
  invariant no longer holds.
