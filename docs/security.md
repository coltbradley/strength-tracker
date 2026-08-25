# Security model

This is a single-user system published as open source. The repo must be safe
to publish: nothing in it is secret, and the design assumes the code is
public. Security lives in the deployment, not in obscurity.

## What is secret (and lives only in deployment)

| Secret                      | Where it lives                                     | Blast radius if leaked                                                                                                                                                              |
| --------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_SECRET` bearer token   | Edge function secret + local Claude Desktop config | Full MCP tool surface: read training data, write programs/TMs/goals. Cannot touch `sessions`/`sets` (no tool exists). Rotate by setting a new secret and updating the local config. |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge runtime only (platform-injected)              | Full database. Never in the repo, never in the PWA, never logged.                                                                                                                   |
| `OWNER_USER_ID`             | Edge function secret                               | Not sensitive alone (it's a uuid), but treated as config, not code.                                                                                                                 |
| Supabase anon key + URL     | PWA build env                                      | Public by design. Safe because RLS is the enforcement layer, not the key.                                                                                                           |

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
   is null on that path and RLS cannot scope it. Instead: the service client
   is constructed in exactly one module, every query stamps/filters
   `OWNER_USER_ID`, and the tool surface is the authorization boundary,
   there are no tools that write `sessions` or `sets`, so the training
   record is unreachable from MCP by construction. The tradeoff (service
   role behind a bearer check vs. running a full OAuth 2.1 server for one
   user) is argued in decisions.md.
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

- **Stolen bearer token**: worst realistic case. Attacker reads training
  data and writes junk programs (unconfirmed) / TMs / goals. Training
  history is untouchable. Mitigation: long random token, HTTPS only,
  rotation is one command. Accepted for a single-user system.
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
