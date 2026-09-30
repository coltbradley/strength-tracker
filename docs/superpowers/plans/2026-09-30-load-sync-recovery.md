# Load entry and failed queue recovery, 2026-09-30

## Failure boundary

The September 30 phone report showed five failed queued writes with the
database's authored-load consistency error. A focus load step changes
`entryKg` without clearing the old `enteredLoad`; the outbox then retains a
set whose total and provenance disagree. Cursor PR #14 corrects the display
unit but can generate another disagreement when it rounds a kg prescription
to one decimal lb before writing both values. Existing failed writes remain
on the phone and are not repaired by a new build alone.

## Constraints

- Preserve `sets` as append-only and `load_kg` as total system kg.
- Preserve every queued UUID, owner, timestamp, index, and training value.
  Preserve the original authored value in an exported copy before a reviewed
  repair marks its contradictory provenance unknown. No automatic deletion or
  replay under an unknown identity.
- Do not change production data or deploy without reviewing the phone queue
  and verifying a safe recovery path. Export the queue before any repair.
- Keep the current worktree and `main` intact. Do not merge stale PR #11.

## Implementation slices

1. Make every focus load adjustment clear or recompute authored provenance.
   Files: `pwa/src/components/session/SetEditor.tsx` and its tests. First add
   a failing test for an authored prefill followed by a focus step. Verify the
   emitted draft can form a consistent set.
2. Integrate the relevant Cursor PR #14 unit display and MCP compatibility
   changes. Files: `pwa/src/lib/format.ts`, `pwa/src/screens/Session.tsx`,
   `supabase/functions/coach/prompt.ts`,
   `supabase/functions/mcp-server/lib/prescriptions.ts`, with their focused
   tests. First add a failing case for kg-authored 100 kg viewed in lb and
   logged unchanged. The stored total and entered value must satisfy the
   production trigger, including a per-side case and explicit lb edits.
3. Inspect the outbox's rejected-item contract and implement a safe path for
   the specific failed set rows if the existing export and retry controls
   cannot recover them. Files, if required: `pwa/src/lib/outbox.ts`,
   `pwa/src/components/OutboxSheet.tsx`, and focused tests. Any repair must be
   owner-scoped, keep the same set UUID and `load_kg`, require a queue export
   and human review, and leave unrelated constraint failures untouched.
4. Reproduce the reported superset overlap at the phone's 402 × 812 viewport
   and fix the card width and small-screen wrapping. Keep the tap targets and
   action row usable at narrower widths.

## Verification and release

Run focused red/green tests for each slice, full PWA tests, typecheck and
build, PGlite validation for the authored-load constraint, and Deno tests for
the touched edge functions. Review the diff against AGENTS.md. Then test the
same kg-to-lb, stepper, per-side, and failed-queue cases in a browser and on
the affected iPhone. Read back the server sets by UUID and the phone's queue
count. A passing CI run alone does not establish recovered phone data.

Rollback: revert the code release with the documented deploy runbook; keep
the exported queue and the original IndexedDB rows. Never clear phone storage
as rollback. No database migration is planned.

## Local verification, 2026-09-30

- Focus load steps now invalidate stale authored provenance. Unit display and
  set payloads use the same visible/typed number; PGlite accepted the new
  total, per-side, and typed-lb examples through the applied load-consistency
  trigger and rejected the old mismatched example.
- A dead set with the exact load-consistency error can be reviewed, exported,
  and retried with its original entered number/unit marked unknown. Its UUID,
  owner, timestamp, index, load total, and other training fields are retained.
  Native file sharing is used when available; cancellation leaves repair
  locked. The recovery has no automatic repair path.
- Superset cards overflowed the 402 px page by 13 px in the lb demo. After
  the layout change, the cards end at x=384 and the page scroll width is 402.
  At 320 px, content wraps inside the cards and the actions remain reachable
  by scrolling. Desktop width remains within the viewport.
- The full PWA, Edge Function, database, selected-column, and release-script
  gates passed locally. The affected installed iPhone's queue export, writes,
  and server readback remain unverified. The plate-diagram and
  next-action complaints lack enough phone context for a confirmed fix.

## Affected phone evidence, later on 2026-09-30

The supplied Unsynced Writes screenshot shows **10 failed writes**, rather
than the five visible in the earlier report: seven set inserts with the exact
authored-load mismatch, two set voids refused by `set_voids` row-level
security, and one set note refused by `set_notes` row-level security. Both
policies require the referenced set to belong to the caller and to exist on
the server. The failed parent set inserts are a plausible cause of the three
dependent refusals, but the screenshot does not show set UUIDs. An export of
the phone queue is required to confirm the links. Do not treat the three as
independent permission bugs or retry them before the parent sets land.

The queue export received afterward contains exactly those ten failed writes,
all queued by one owner in one session. Every void/note points to one of the
seven failed set IDs. The split-squat and calf-raise voids each target an
earlier copy in a correction pair, so successful recovery should leave five
of these seven sets live. The stored totals are 65.77, 34.02, 45.36, and
52.16 kg, nearly exactly 145, 75, 100, and 115 lb; their stale entered fields
are rounded kg values. A read-only live database check found the session
under the same owner, ended and not discarded, and found none of the seven set
IDs, their voids, or their note on the server. The export is the only copy of
those writes until the phone's outbox successfully replays them.

## Read-only server confirmation, 2026-09-30

The export SHA-256 is
`2dcec370efabc5530a82cc39890e65496c30b5ebbd960a587121bcc309d1d421`. Its
internal checks found 10 dead writes: seven unique sets, two voids, and one
note, all for one owner/session; every child targets one of the exported sets.
A read-only production query found 0 of the 7 set UUIDs, 0 of the 2 voids, and
0 of the note on the server. It found the corresponding session ended and not
discarded. This confirms the exported writes have not landed; it does not
confirm recovery. Post-replay phone queue count and server readback by UUID:
**NOT RUN**.

## Phone count update, 2026-09-30

The affected iPhone currently reports 10 failed writes, matching the saved
export's count. This count match does not establish UUID or payload match; a
fresh phone export is requested and pending. A repeated read-only production
query still found none of the seven saved-export set UUIDs, two voids, or note.
No repair or retry has been performed. Replay and post-replay phone count and
server UUID readback remain **NOT RUN**.
