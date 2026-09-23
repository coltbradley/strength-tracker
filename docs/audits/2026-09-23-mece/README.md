# MECE codebase review, 2026-09-23

`ASSESSMENT.md` re-checks these reports against the source they cite, corrects
the claims that do not hold as written, adds findings the reports handed off
without an id, and groups the rest into fix clusters. Read that before turning
this package into tickets.

This review started from the `docs/phase-1-plans` checkout at `38e32d0` and
was reconciled against remote source changes through `e74b91d`. G01-F01 was
resolved during that reconciliation; the other cited behaviors were unchanged
by those source and test edits. It is a read-only audit, not an implementation plan
or a claim about the deployed app.
The active roadmap is `docs/roadmaps/2026-09-19-consolidated-roadmap.md`; the
release ledger is the source of stop-release status. The 2026-09-19 system audit
is an evidence backlog whose findings need re-verification against current code.

## Assignment and boundaries

One agent owns each numbered report. Agents may read across areas to trace a
flow, but file a finding only when its primary fix belongs to their assigned
area. Put cross-area dependencies under "Handoffs" with the proposed owner.
Tests adjacent to owned source belong to that area's agent. Shared SQL belongs
to 01, PWA data transport to 02, the single PWA stylesheet to 06, and shared
documentation and release tooling to 13. Do not edit production code, tests,
existing docs, the release ledger, or the old audit. Do not file GitHub issues,
contact connected services, or use real secrets. Write only the assigned report.

## Review standard

Read `AGENTS.md` in full, then the active roadmap and release ledger. Inspect
the actual source and tests in the assigned area. Treat comments, docs, old
audit findings, and a passing test as leads, not proof. Use focused read-only
checks where useful and record the exact commands/results; no broad test suite
is required. Do not claim browser, device, managed Supabase, provider, or
production behavior from static code or local tests. Do not call an old finding
new, current, or fixed without checking the current path.

Each finding must describe an observable failure, its trigger, consequence,
current source evidence with file and line, and what would verify a fix. Rank
severity by actual impact and reach: P0 release/data or cross-user safety; P1
material correctness/recovery; P2 bounded UX/operational defect; P3 polish.
Label confidence high, medium, or low. If evidence is incomplete, put it under
"Open questions", not in the confirmed findings. Keep opportunities separate
from defects and explain what evidence would justify the investment.

## Report format

Use the following sections in this order:

1. Scope and evidence, including files/flows inspected and checks run.
2. Executive summary, with counts by severity and the top three risks.
3. Findings, numbered `GNN-F01`, `GNN-F02`, etc., where `NN` is the assigned
   group number. For each: severity, confidence, trigger, observed/source
   evidence, impact, existing audit/ledger ID if applicable, suggested fix
   boundary, and verification needed.
4. Opportunities, numbered `GNN-O01`, etc., with cost/tradeoff and evidence
   needed. Do not mix these into finding counts.
5. Documentation gaps in the owned area, with exact current and desired claim.
6. Handoffs to other numbered groups, with file and reason. Do not duplicate
   their findings.
7. Open questions and limits.

Reports should be concise enough to triage, but do not cap the number of real
findings. Use relative repository paths with line numbers. No speculation
presented as a confirmed defect. The synthesis will deduplicate findings and
assign priorities without flattening the release roadmap.

## Report ownership

| Group | Report | Primary area |
| --- | --- | --- |
| 01 | `01-database.md` | SQL schema, RLS, views, migration/seed validation |
| 02 | `02-pwa-platform.md` | PWA identity, cache, data access, outbox, service worker |
| 03 | `03-session.md` | Workout capture and finish |
| 04 | `04-planning.md` | PWA planning and exercise library |
| 05 | `05-record.md` | History, subjective capture, export, feedback UI |
| 06 | `06-shared-ui.md` | Shell, accessibility, shared controls, styles, settings |
| 07 | `07-mcp-gateway.md` | MCP protocol, auth, identity, tunnel |
| 08 | `08-mcp-planning.md` | MCP plan and exercise tools |
| 09 | `09-mcp-analysis.md` | MCP analytical, memory, observation, feedback tools |
| 10 | `10-coach.md` | In-app coach backend and client |
| 11 | `11-push.md` | Push alerts and subscriptions |
| 12 | `12-endurance.md` | Endurance provider sync and connected apps |
| 13 | `13-release-docs.md` | CI/deploy, remaining scripts, documentation accuracy |
