# Version D light implementation map

Planning draft for review, 2026-09-30. This is a sequence of independently
reviewable changes, not a claim that the design is implemented. The source is
Version D of `Mobile app design review board.zip`; prototype text is design
evidence, not project instruction. Read the [design spec](../specs/2026-09-30-version-d-light-design.md)
with each plan and recheck source if HEAD has moved beyond `d5e7b64`.

| Order | Work | Result | Gate |
| --- | --- | --- | --- |
| 0 | Recover and read back the affected September 30 phone queue; finish the active Phase 2 browser/phone/readback checks | Trustworthy release baseline | Required before releasing any D UI |
| 1 | [Light session UI](2026-09-30-version-d-session-ui.md) | D Focus/List, dock, rest on the existing owner, with neutral last-set text | Rendered phone pass and existing logging tests |
| 2 | [Per-set receipts](2026-09-30-version-d-receipts.md) | Local/server status grounded in exact outbox operations | Correction, reload, account, and UUID readback tests |
| 3 | [Session-local choices](2026-09-30-version-d-session-local.md) | Per-session units and navigation order without changing default or plan | Conversion, grouping, and reload tests |
| 4 | [Surrounding screens](2026-09-30-version-d-surrounding-screens.md) | Consistent light Train, preview, End, Program, Record | End-to-end browser and phone pass |

Order 1 may be built and reviewed before gate 0 closes, but not released. Order
2 is needed before any individual “Synced” or “Already saved” claim. Order 3
can follow the session UI without waiting for surrounding-screen styling.
Each plan ends in a separately reviewable commit. The user will test the
small controls in actual use; the one pre-implementation flag is a visible
38 px control requiring a 44 px actionable area.

No initial slice adds a table or changes server metrics. Dark mode, added
bodyweight load, coach Apply, and pinned Record goals remain separate product
decisions. D is a clear visual direction, but it needs React composition,
offline receipt work, and phone validation rather than a direct HTML port.

## Execution authorization, 2026-09-30

Colt authorized implementation with GPT-6 Luna subagents, tests and incremental commits. Recovery of the old affected phone writes is no longer a prerequisite. Keep the recovery tools and underlying load-consistency fixes. New-data durability and browser/phone acceptance remain separate evidence requirements. Follow [the execution record](2026-09-30-version-d-execution.md) for current progress; older unchecked boxes are not current completion evidence.
