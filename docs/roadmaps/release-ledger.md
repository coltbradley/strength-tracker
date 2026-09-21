# Release ledger

Status source of truth for stop-release and Phase 0 re-verification items.
Do not scatter status in `docs/plan.md` or old implementation plans.

States: `open` · `fixed with test` · `needs live proof` · `not reproducible`.
A finding is not closed because the audit is old. Close only with a regression
test and the evidence layer the roadmap names.

| ID    | Boundary                        | Owner       | State | Regression test | Production proof | Rollback |
| ----- | ------------------------------- | ----------- | ----- | --------------- | ---------------- | -------- |
| A-01  | MCP tunnel readiness            | Engineering | open  | —               | —                | —        |
| A-02  | Coach allowlist                 | Engineering | open  | —               | —                | —        |
| A-03  | Cross-user parent refs          | Engineering | open  | —               | —                | —        |
| A-07  | Coach quota reservation         | Engineering | open  | —               | —                | —        |
| A-24  | PWA env validation              | Engineering | open  | —               | —                | —        |
| A-25  | Backend deploy skipped          | Engineering | open  | —               | —                | —        |
| A-26  | CI coach tests                  | Engineering | open  | —               | —                | —        |
| A-49  | NaN rejection                   | Engineering | open  | —               | —                | —        |
| A-69  | Push SSRF                       | Engineering | open  | —               | —                | —        |
| A-74  | Endurance checkpoint history    | Engineering | open  | —               | —                | —        |
| A-75  | Endurance pagination            | Engineering | open  | —               | —                | —        |
| A-76  | Invalid provider payload        | Engineering | open  | —               | —                | —        |
| A-84  | Training-plan replacement       | Engineering | open  | —               | —                | —        |
| A-90  | Prefetch auth attribution       | Engineering | open  | —               | —                | —        |
| A-91  | Session close zero-row          | Engineering | open  | —               | —                | —        |
| A-92  | Prescription edit adherence     | Engineering | open  | —               | —                | —        |
| A-94  | Health prompt responded_at      | Engineering | open  | —               | —                | —        |
| A-98  | Export completeness             | Engineering | open  | —               | —                | —        |
| A-99  | Readiness second device         | Engineering | open  | —               | —                | —        |
| A-107 | Log before outbox commit        | Engineering | open  | —               | —                | —        |
| A-134 | Deploy after failed CI          | Engineering | open  | —               | —                | —        |
| A-135 | Production verify/rollback      | Engineering | open  | —               | —                | —        |
| A-136 | MCP health probe                | Engineering | open  | —               | —                | —        |
| A-137 | Alert-sweep scheduler           | Engineering | open  | —               | —                | —        |
| A-138 | Alert-sweep operator alert      | Engineering | open  | —               | —                | —        |
| A-139 | PWA endurance-sync URL          | Engineering | open  | —               | —                | —        |
| A-140 | Endurance sync scheduler        | Engineering | open  | —               | —                | —        |
| A-141 | Endurance connect/revoke        | Engineering | open  | —               | —                | —        |
| A-143 | Online outbox retry             | Engineering | open  | —               | —                | —        |
| A-148 | Held outbox disclosure          | Engineering | open  | —               | —                | —        |
| A-149 | Legacy MCP_SECRET               | Engineering | open  | —               | —                | —        |
| A-150 | Fabricated assistant history    | Engineering | open  | —               | —                | —        |
| A-151 | Caller-controlled confirm flags | Engineering | open  | —               | —                | —        |
| A-152 | Unescaped user text into coach  | Engineering | open  | —               | —                | —        |
| A-156 | Push subscription fanout        | Engineering | open  | —               | —                | —        |
| A-157 | Endurance backfill window       | Engineering | open  | —               | —                | —        |
| A-158 | Persisted-session project mix   | Engineering | open  | —               | —                | —        |
| A-159 | Endurance credentials cleartext | Engineering | open  | —               | —                | —        |
| A-95  | Prompt engine unwired           | Engineering | open  | —               | —                | —        |
| A-96  | Check-in redesign               | Engineering | open  | —               | —                | —        |
| A-97  | Check-in history                | Engineering | open  | —               | —                | —        |
| A-105 | Session skips record            | Engineering | open  | —               | —                | —        |
| A-119 | Coach-observation loop          | Engineering | open  | —               | —                | —        |
| A-120 | Notes into memory extract       | Engineering | open  | —               | —                | —        |
