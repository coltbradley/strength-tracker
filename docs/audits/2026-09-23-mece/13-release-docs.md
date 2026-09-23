# Group 13: Release, validation, and documentation

## Scope and evidence

Reviewed repository `strength-tracker`, checkout `docs/phase-1-plans`, HEAD `eb74c1e`. The audit README pins the initial source revision at `38e32d0`; `git diff --stat 38e32d0..HEAD -- . ':!docs/audits'` returned no source changes, so this scope has no code drift from that pin. Read `AGENTS.md`, the audit README, active roadmap, and release ledger. Inspected `.github/workflows/{ci,deploy}.yml`, `scripts/check-pwa-env*`, `scripts/check-deploy-contract.test.mjs`, `scripts/lib/release-ledger.mjs`, release-ledger tests/checker, `scripts/push-auth-config.sh`, package manifests/locks, PWA dev fixtures, README and release/setup/architecture/security documentation. Read group 07 and group 11 reports for overlap. No tests, build, deployment, live service, or secret access was performed; evidence is static source and documentation only.

## Executive summary

Confirmed: 2 P1, 1 P2. The release workflow can publish without CI passing, and its post-publish receipt can report the source SHA without verifying that Pages serves that build. README auth guidance also conflicts with the implemented OAuth sign-in path. The first risk is already tracked as open A-134; the receipt proof is part of A-135's remaining production-verification boundary.

## Findings

### G13-F01. Main releases do not wait for CI

- **Severity:** P1. **Confidence:** High.
- **Trigger:** A `main` push changes deployable `pwa/` or `supabase/` files while CI fails or does not run.
- **Observed/source evidence:** CI and deploy are separate workflows (`.github/workflows/ci.yml:3-9`, `.github/workflows/deploy.yml:23-27`). The deploy `pages` job depends only on `changes` and `supabase`, and its gate checks only the Supabase job result (`.github/workflows/deploy.yml:123-133`). The contract test explicitly asserts that deploy has no CI dependency (`scripts/check-deploy-contract.test.mjs:8-15`). Thus a CI failure cannot block a publish or backend deploy through this workflow.
- **Impact:** Type, database validation, selected-column, and function test failures can coexist with a successful release. The active roadmap records CI billing as the reason not to wait; that explains the choice but leaves the release exposure open.
- **Existing audit/ledger ID:** A-134, open (`docs/roadmaps/release-ledger.md:35`; roadmap disposition at `docs/roadmaps/2026-09-19-consolidated-roadmap.md:14-21`).
- **Suggested fix boundary:** Release engineering. Either establish a passing required check that can run under current billing constraints, or retain A-134 as an explicit release risk and prevent a green CI label from being treated as a deployment gate.
- **Verification needed:** Inspect current GitHub Actions billing and repository rules (not available in this static review); then demonstrate that an intentionally failing required validation prevents every production-mutating job, or record the accepted exception and its operator procedure.

### G13-F02. The deploy receipt does not verify the deployed PWA SHA

- **Severity:** P1. **Confidence:** High.
- **Trigger:** The Pages URL returns HTTP 200 while serving stale content, or `PAGES_URL` points to a different healthy site.
- **Observed/source evidence:** The Pages job builds with `VITE_BUILD_SHA: ${{ github.sha }}` (`.github/workflows/deploy.yml:160-164`) and then publishes `pwa/dist` (`:167-171`). Its smoke step downloads only the response body for the configured/default root URL, checks the HTTP status, optionally checks MCP `/health`, and prints the workflow's `github.sha` in the receipt (`:172-202`). It never inspects the downloaded HTML or assets for the embedded build SHA. The contract test only asserts that a curl and the literal `github.sha` occur after the publish step (`scripts/check-deploy-contract.test.mjs:48-58`). The ledger treats the next `receipt sha=` line as production proof for A-135 (`docs/roadmaps/release-ledger.md:36`), and the active roadmap repeats that criterion (`docs/roadmaps/2026-09-19-consolidated-roadmap.md:16`).
- **Impact:** A successful receipt can identify the attempted source revision while the actual served app is old or belongs to another URL. That can falsely close the direct production-readback gate.
- **Existing audit/ledger ID:** A-135, marked fixed with test but still awaiting production proof (`docs/roadmaps/release-ledger.md:36`).
- **Suggested fix boundary:** Release workflow smoke and its contract test. Read back a stable build identifier from the served PWA and compare it to `github.sha`; validate the target URL against the configured Pages site before emitting the receipt.
- **Verification needed:** Test a Pages response that returns 200 with a stale or mismatched build identifier and prove the step fails without emitting a receipt; then inspect a real next-deploy receipt and served build identifier.

### G13-F03. README says OAuth and ChatGPT connector sign-in are unavailable

- **Severity:** P2. **Confidence:** High.
- **Trigger:** A new operator follows README's MCP setup description to connect a sign-in-only client.
- **Observed/source evidence:** README states MCP clients use a static bearer, that ChatGPT accepts a URL-plus-key field, and that OAuth is “not built” (`README.md:39-47`). The same repository's current setup guide says ChatGPT offers OAuth or no authentication and documents sign-in setup (`docs/setup.md:185-203`). The current function verifies Supabase OAuth-issued tokens (`supabase/functions/mcp-server/lib/oauth.ts:1-16`, `106-125`), and `supabase/config.toml` enables the OAuth server (`:19-23`).
- **Impact:** README sends operators toward unsupported fixed-header ChatGPT setup and tells them the implemented OAuth option does not exist, so they can fail to connect or miss the supported sign-in route.
- **Existing audit/ledger ID:** Related to group 07's A-52 setup-doc lead. The current `docs/setup.md` now documents sign-in; the remaining contradiction is in the README.
- **Suggested fix boundary:** Update the README's auth summary and client diagram to distinguish static bearer clients from OAuth sign-in clients, consistent with `docs/setup.md` and current code.
- **Verification needed:** Compare every README connection claim against the currently supported client setup instructions and check the MCP OAuth discovery/consent flow with a test account.

## Opportunities

None identified in this bounded review.

## Documentation gaps

- `docs/deploy.md:3-30` presents a 2026-09-12 production snapshot and says the 2026-09-17 live-session adaptation work is not deployed (`:27-30`, repeated as a checklist at `:32-64`). The active roadmap's newer 2026-09-21 verified starting point records production migrations through `20260917030000`, current function versions, and a PWA publish (`docs/roadmaps/2026-09-19-consolidated-roadmap.md:89-97`). Keep the historical snapshot clearly labeled, but add a current status pointer/update so the runbook's opening release state is not mistaken for present state.
- `README.md:53-58` reports 22 MCP tools and six PWA screens. The current MCP handler registers a materially expanded tool surface (`supabase/functions/mcp-server/lib/handler.ts:75-124`), and the PWA now includes additional screens such as Plan and OAuth consent (`pwa/src/screens/Plan.tsx`, `OAuthConsent.tsx`). Replace counts with a non-counted description or update them from current source.

## Handoffs

- **Group 07, MCP gateway:** No code handoff. The old A-52 claim that OAuth setup is omitted from `docs/setup.md` is no longer current; the sign-in section exists at `docs/setup.md:185-203`. The remaining stale claim is the README finding above.
- **Groups 01/02/07/08/09/10/11/12:** No implementation findings handed off. CI and deploy coverage is described only at the workflow boundary here; feature correctness and individual test coverage remain with their assigned reports.

## Open questions and limits

- GitHub branch protection, billing, repository variables, the deployed Pages URL, and whether a next-deploy receipt currently exists were not inspected. The roadmap's documented CI billing constraint is treated as a repository statement, not independently verified live state.
- Static evidence cannot establish whether GitHub Pages serves the just-published artifact or whether OAuth discovery, consent, and client sign-in succeed in production.
- No issue was raised about the intentional PWA publish when the Supabase job is skipped; that is documented release behavior. No conclusions are made about managed Supabase scheduler/Vault state, which group 11 separately leaves for live verification.
