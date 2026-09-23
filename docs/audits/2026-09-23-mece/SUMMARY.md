# MECE codebase audit synthesis, 2026-09-23

## Decision in brief

This is a triage package, not a release verdict or an implementation queue. The
13 area reports below started from `docs/phase-1-plans` at `38e32d0` and were
reconciled against remote source changes through `e74b91d`. Those changes
resolved G01-F01; the other findings' cited behaviors were unchanged.
The branch's Phase 1 work is still separate from `main`. The active roadmap and
release ledger govern phase order and stop-release status. Older A-numbers are
cross-references to the 2026-09-19 evidence backlog, not claims that every old
finding remains open.

At the initial snapshot, `node scripts/check-selects.mjs` failed on the MCP
health query (G01-F01). After the remote parser and health-query corrections
were merged, the same check passed with 459 selected columns. Other findings
are grounded in current source paths and adjacent tests, with their required
reproduction or live proof stated in the area report. `node
scripts/validate-db.mjs` passed in the database review. No
full test matrix, browser/device run, hosted Supabase check, provider call, or
production deploy was performed for this package.

Across the 13 reports there are 95 active findings: 1 P0, 39 P1, and 55 P2.
One additional P1 (G01-F01) was resolved by the concurrent remote work. These
are triage severities, not a claim that all paths reproduced at
runtime or that every item belongs in the next release.

## Separate area reports

| Group | Report | Findings | Primary next verification |
| --- | --- | ---: | --- |
| 01 Database | [01-database.md](01-database.md) | 2 active, 1 resolved | FK delete and NaN fixtures; CI/health proof for resolved check |
| 02 PWA platform | [02-pwa-platform.md](02-pwa-platform.md) | 15 | Two-account and IndexedDB fault injection |
| 03 Workout capture | [03-session.md](03-session.md) | 6 | Interrupted log, finish/discard race, timed-set round trip |
| 04 Phone planning | [04-planning.md](04-planning.md) | 7 | Delayed Plan reads and multi-request failure injection |
| 05 Record and check-ins | [05-record.md](05-record.md) | 7 | Export fixtures, offline History, prompt lifecycle |
| 06 Shared PWA UI | [06-shared-ui.md](06-shared-ui.md) | 7 | Two-tab settings and accessibility/browser smoke |
| 07 MCP gateway | [07-mcp-gateway.md](07-mcp-gateway.md) | 5 | Body limits, OAuth grant tests, tunnel stderr fixture |
| 08 MCP planning | [08-mcp-planning.md](08-mcp-planning.md) | 10 | Plan-write interruption and concurrency fixtures |
| 09 MCP analysis | [09-mcp-analysis.md](09-mcp-analysis.md) | 6 | Date bounds, large reads, observation transitions |
| 10 In-app coach | [10-coach.md](10-coach.md) | 10 | Recovery/quota/extraction fault injection |
| 11 Push alerts | [11-push.md](11-push.md) | 6 | Fanout and concurrent sweep fixtures |
| 12 Endurance imports | [12-endurance.md](12-endurance.md) | 11 | Provider pagination/correction and checkpoint fixtures |
| 13 Release and docs | [13-release-docs.md](13-release-docs.md) | 3 | Served-build SHA readback; current workflow policy |

Each finding has a `GNN-FNN` ID, owner, severity, trigger, source evidence,
impact, and a verification condition. Opportunities use `GNN-ONN` and remain
separate from defect counts. The report README states the ownership and
severity rules.

## Actionable triage by boundary

| Boundary | Evidence to act on | Decision or next proof |
| --- | --- | --- |
| Wrong-account data | G02-F01 (new writes can be ownerless at enqueue), G02-F05 (fallback can pick another Supabase project's session), G02-F06 (shared-device queue reveals another owner's payload) | Treat as a tenant-safety gate. Reproduce with two accounts, auth delay, and a shared device before any beta expansion; define a safe legacy ownerless-row path. |
| Local training durability | G03-F01 (set shown before durable enqueue), G02-F11/G02-F15 (post-commit errors look like failures), G03-F02 and G02-F07/G02-F12 (terminal writes race or succeed with zero rows) | One Phase 2 lifecycle slice should fault-inject enqueue, retry, concurrent close, and second-device completion. Require readback of the final server state. |
| Plan meaning and mutation | G04-F01/G04-F04 (stale editor and partial section writes), G08-F01/G08-F03/G08-F05 (retry collision, duplicate phase program, lost live training plan), G01-F02 (composite FK delete action can null owner), G08-F02 (superset meaning differs by surface) | Assign one owner for shared plan contracts before code changes. Exercise whole-day/plan transactions, retries, and the same superset fixture through MCP, Plan, Session, and SQL. |
| Release proof | G01-F01's validator now passes locally after upstream changes. G13-F02 finds that the Pages receipt prints the intended SHA without reading it from the served app. G13-F01 is the already-open A-134 policy where deploy does not wait for billed-out CI. | Run CI and deployed health on the integrated tip; make the smoke receipt compare the served build identifier to the expected SHA. Keep the CI billing exception explicit until a required check can actually run. |
| Public gateway and coach spend | G07-F01 lacks a bounded request body; G07-F02 lacks local resource/scope validation and needs issuer-token proof; G08-F06 accepts a caller confirmation flag for confirmed-program deletion; G10-F01 retains sensitive context by default; G11-F01 permits unbounded push fanout. | Verify actual token grants and approval authority, add size/fanout tests, and make the retention policy a product decision with production configuration proof. |
| Existing user flows | G03-F03 cannot write timed duration; G04-F03 hides older live programs; G05-F01 exports incomplete set semantics; G09-F01 excludes most of an inclusive bodyweight end date; G10-F02/F03/F04 cover coach recovery. | Give each flow a focused round-trip test, then phone/browser acceptance where screen behavior matters. These are existing contracts, not new feature proposals. |
| Deferred operations | G05-F06 records the missing subjective prompt caller; G11-F02-F05 cover alert recovery. G12-F01/F02/F03/F05/F10 would leave provider imports incomplete or stale, while G12-O01/O02 describe Phase 5 connection and scheduling work. | Keep these visible, but follow the roadmap's Phase 5 gate for endurance product work. Validate the existing sync foundation before adding a user-facing connection flow. A scheduler's SQL or code path alone is not live delivery proof. |

## Reconciliation rules for implementation

- Keep G05-F06 as the single missing prompt-caller finding. Group 11 owns what
  happens after a prompt has been armed, so its report refers back to G05-F06.
- Keep G08-F02 as the primary non-contiguous-superset finding. Groups 03 and
  04 provide the Session and Plan evidence needed to verify one shared rule.
- Keep G02-F15 with the shared data layer rather than counting the same
  bodyweight post-commit failure in group 05. Keep G05-F07 with check-in client
  code rather than duplicating it in group 10.
- Group 12 owns provider sync behavior. Group 01 owns the cross-source SQL
  deduplication and field constraints handed off by G12; Group 13 owns the
  setup and deployment claims about encrypted credentials and revocation.
- The old audit and release ledger remain separate status records. For example,
  A-49 is marked fixed with a test, while G01-F03 shows other numeric fields
  still accept NaN by current source. Do not change ledger status without a
  targeted regression and the evidence layer the roadmap requires.
- Doc corrections are actionable but should follow the verified behavior:
  README's OAuth setup and tool/screen counts (G13-F03), MCP server README's
  tool inventory (group 07), and the release runbook's opening dated status
  (group 13). The docs owner should edit shared files once after fixes and
  policy decisions are clear.

## Limits and next gate

The reports identify source-supported defects and opportunities. Their P0/P1
labels describe potential impact, not proof that the same paths occurred in
production. The source branch's Phase 1 release and identity gates still need
direct proof, including the production coach allowlist (A-02), served build
readback (A-135), and live alert-sweep inspection (A-137/A-138). Phase 2 phone,
browser, offline, and two-account acceptance remains a separate gate before
friend beta. No agent changed production code or the release ledger in this
audit.
