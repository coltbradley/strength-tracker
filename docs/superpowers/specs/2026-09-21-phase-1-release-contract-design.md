# Phase 1 Slice 2: a deploy contract that does not wait on CI

Date: 2026-09-21. Status: approved in design conversation the same day.

Base: `main` at `0166154`. Implement **after** Slice 1, on its own branch
and PR. Do not mix with coach/RLS/migrations.

Inputs: roadmap Phase 1 slice 2; audit A-24, A-25, A-26, A-134, A-135,
A-136, A-137, A-138. Locked constraint: GitHub Actions **CI is billed-out
and fails automatically**. Deploy still runs. A release must not wait on CI.

Companion plan: `docs/superpowers/plans/2026-09-21-phase-1-release-contract.md`.
Slice 1 is `docs/superpowers/specs/2026-09-21-phase-1-admission-design.md`.

## Principle

A missing PWA env cannot publish. A skipped backend cannot publish a client
that needed it. A deployed release has a smoke receipt. Rollback is written
down. **CI remaining red due to billing does not block deploy.**

## Locked decisions

1. No `workflow_run` waiting on CI. No required status checks that make
   `main` undeployable. No job that treats a missing CI run as a failed
   release.
2. When billing is restored, a later follow-up may add an **optional**
   `require_ci` dispatch input defaulting to false. Not in this slice.
3. If `supabase/` changed and deploy secrets are missing, the supabase job
   **fails** (not skip-success). If supabase paths did not change, the job
   stays skipped so docs-only / pwa-only pushes still publish.
4. Pages rollback is revert the deploy commit. Migrations are append-only:
   never invent a database undo; forward-fix with a new migration.
5. `/health` stays unauthenticated. 200 only if required env and a trivial
   DB/token-store ping work. 503 otherwise. No user data in the body.
6. A-26 (coach CI tests) already `fixed with test` in Phase 0. No work.
7. A-134 is documented as deferred until Actions billing works. Ledger:
   honest state, not "fixed."

## Problems this slice closes

| ID            | Failure                                                   | Fix                                                                                     |
| ------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A-24          | CI/deploy can publish a PWA with placeholder Supabase env | `scripts/check-pwa-env.mjs` before `vite build`; production client refuses placeholders |
| A-25          | Backend skip is success; Pages still publishes            | Supabase job **fails** when paths changed and secrets are missing                       |
| A-26          | Coach tests omitted from CI                               | Already fixed in Phase 0                                                                |
| A-134         | Deploy can publish a commit whose CI failed               | Deferred; do not wait on CI while billing is broken                                     |
| A-135         | No production verification or rollback                    | Smoke curls + receipt in the job log; rollback section in `docs/deploy.md`              |
| A-136         | `/health` is a false-green liveness probe                 | Env + DB/token-store ping                                                               |
| A-137 / A-138 | Alert-sweep can be missing with no operator signal        | Documented operator query; no pager                                                     |

## PWA env (A-24)

New `scripts/check-pwa-env.mjs`:

- Reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `process.env`.
- URL must be `https:` and hostname must end with `.supabase.co` (or equal
  a documented self-hosted host if one exists; today it is supabase.co).
- Anon key must look like a JWT: three base64url segments (`/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`).
- Exit 1 with a message that names the missing/invalid var, never the value.

`scripts/check-pwa-env.test.mjs` covers: missing, `http://`,
`https://placeholder.supabase.co`, short anon key, valid pair.

`deploy.yml` pages job runs `node scripts/check-pwa-env.mjs` immediately
before `npm run build`, with the same `env:` block the build uses.

`pwa/src/lib/supabase.ts`: in a **production** Vite build
(`import.meta.env.PROD`), if url/anon are missing or still the placeholder
strings, throw at module init. Dev and `VITE_DEMO === "1"` keep the
placeholder client so `npm run dev` still boots.

## Backend skip becomes failure (A-25)

Today `deploy.yml` supabase job: if secrets are missing, `on=false`,
notice, exit 0. Pages `if:` allows skip (`always()` and result != failure).

Change: when `needs.changes.outputs.supabase == 'true'` and the three
settings are not all set, the gate step **fails** (`exit 1`). Pages already
blocks on `needs.supabase.result == 'failure'`.

When supabase paths did **not** change, the supabase job is skipped by its
`if:` (`needs.changes.outputs.supabase == 'true'`). That skip stays. Pages
still publishes a PWA-only change.

## Smoke and receipt (A-135)

After `peaceiris/actions-gh-pages`, a smoke step:

1. `curl -fsS` the Pages URL (`https://coltbradley.github.io/strength-tracker/`
   or `vars.PAGES_URL` if present). Fail the job on non-200.
2. If `vars.SUPABASE_PROJECT_REF` is set, `curl -fsS`
   `https://<ref>.supabase.co/functions/v1/mcp-server/health` (or the
   project's functions URL). Expect 200 after A-136. If the var is unset,
   skip the MCP curl and print that it was skipped.
3. Print a receipt: `github.sha`, `github.run_id`, whether supabase job
   ran, HTTP codes. No secrets.

Rollback in `docs/deploy.md`:

- PWA: revert the gh-pages commit or revert the `main` commit that
  triggered Pages and re-run deploy.
- Migrations: do not roll back. Add a new numbered migration.
- Functions: redeploy the previous known-good SHA with
  `supabase functions deploy <name>`.

## MCP health (A-136)

`GET .../health` in `handler.ts` stays unauthenticated and before
`resolveCaller`.

200 body (no user data):

```json
{ "status": "ok", "server": "strength-tracker", "transport": "streamable-http" }
```

503 when `getClient()` throws (missing `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY`) or a `mcp_tokens` `select` with `head: true`
`limit 1` errors. Do not return the error message from Postgres to the
client; log it server-side.

`protocol.test.ts` already hits `/health`. Add a case where env is missing
→ 503. Restore env after.

## Alert-sweep operator visibility (A-137, A-138)

No pager. In `docs/deploy.md`, add a short "Is the sweep alive?" section:
the existing inspection queries, plus "a missing Vault row means the sweep
does nothing and says so." Ledger: A-137 / A-138 `needs live proof` with
that doc as production proof, or stay `open` if no live check was run.
Do not claim `fixed with test` for a cron that PGlite cannot install.

## A-134

Ledger row stays not-fixed. State: keep `open` or use a production-proof
note "deferred: GitHub Actions CI billing; deploy must not wait." Do **not**
invent a fifth ledger state. `open` plus a rollback/production-proof cell
that says "deferred until CI billing is restored" is enough. Checker
already allows `open`.

## Out of scope

Slice 1 identity work. Branch protection. `workflow_run`. Phase 2 E2E.
Repairing GitHub billing.

## Exit

`node --test scripts/check-pwa-env.test.mjs` passes. A pages job with a
placeholder URL would fail the env check. A supabase-path push without
secrets fails the supabase job. `/health` 503s without env. `docs/deploy.md`
names Pages revert and forward-only migrations. A-134 is still `open`.
