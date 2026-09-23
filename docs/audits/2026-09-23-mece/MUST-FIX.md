# Must-fix list

Cut from the MECE audit, the release ledger, and the Phase 2 exit gate in
`docs/roadmaps/2026-09-19-consolidated-roadmap.md`: a retry or a second device
must not duplicate, hide, or disclose a set, and a session must end in exactly
one terminal state. Phase 3 says to pause the beta for data loss, a
cross-account write, or a release-integrity defect.

There are no open GitHub issues. Sentry was not readable from this pass
(the connector needs auth), so nothing here is a production stack trace.
Every row was re-read in source. Detail and the corrections live in
`ASSESSMENT.md`.

Eight items. Fix them in this order. Anything not on this list can wait.

## 1. A queued write can land on the wrong account

Ledger A-90, A-158, A-148. Audit G02-F01, G02-F04, G02-F05, G02-F06.

`enqueue` while `getCurrentUserId()` is null stores no `user_id`. The flusher
treats a missing owner as a legacy row and sends it. The insert has no owner
column, so Postgres stamps whoever holds the token. The persisted-session
fallback can pick another project's `sb-*-auth-token` and show that identity
while the token is someone else's. The outbox sheet exports every account's
payloads. The cache claim can paint the previous account's plan during the
switch.

This is the only P0. `sets` is append-only, so a wrong owner cannot be
corrected.

Done when: a log during the auth-null window is held or refused, never sent;
only the configured project's storage key is read; the sheet and export show
the current owner's payloads; a two-account test on one origin sends nothing
across the boundary.

Landed for A-90, A-158, and A-148. A write queued with no owner is stored as
`user_id: null` and held, including after a later sign-in. A legacy row with
the field missing is held too. The persisted session is read only from
`sb-<project-ref>-auth-token`. `inspect` and the sheet export omit another
account's payloads; the held count remains. The cache-claim race named above
(G02-F04) is still open.

## 2. A set is shown before it is the only copy, and a retry can write it twice

Ledger A-107. Audit G03-F01, G02-F11, G02-F15. History half is N01.

`Session.tsx` adds the set to the screen, then calls `outbox.enqueue` without
waiting. If the add fails, or the app dies before it, the set is gone and the
screen already said it was logged. If the add succeeds and the following count
or bodyweight-cache read throws, the caller sees failure and a retry creates a
second UUID. History does not merge `pendingSets`, so the same queued set is
invisible there until flush.

Done when: the screen shows a set only after the IndexedDB add; a post-add
failure still flushes that one row; offline History shows the queued set once.

Landed for A-107. `logSet` shows the set only after `enqueue` resolves, and a
rejected add leaves the screen unchanged. `enqueue` and `enqueueBatch` still
flush the committed row when the following count throws. `recordBodyweight`
returns the point after the queue write and reports a cache failure instead
of rejecting. History's open day merges `pendingSets` with the server rows
and still hides a pending void. A session finished only on this device, with
no server `ended_at`, is still absent from the list (the other half of N01).

## 3. One session can finish and be discarded

Ledger A-91, and the Phase 2 names A-06 and A-204. Audit G03-F02, G02-F07,
G02-F12, N04.

Finish has a re-entry guard. Discard does not. Both updates can sit in the
queue. The transport treats a zero-row update as success and deletes the queue
item, so a close that changed nothing is gone. `discard` updates by id and
does not require `ended_at` to still be null, so this phone can discard a
session another phone just completed. `complete` does not require
`discarded_at` to still be null.

Done when: one terminal action is queued; a zero-row update stays in the
queue and is visible; discard and complete both no-op once the session is
already closed; a completed session never gains `discarded_at`.

Landed for A-91. A-06 and A-204 are Phase 2 names, not ledger rows, and the
same tests cover them. End shares one close lock, so a second tap while
finish or discard is in flight does not enqueue. A session update that
matches zero rows stays in the queue as dead and visible. Finish, and a
discard from End, the orphan card, or the overnight sweep, match only a
session that is still open, so a completed session does not gain
`discarded_at` and a discarded one does not gain `ended_at`. History can
still discard a finished session: that write matches `discarded_at is null`
and leaves `ended_at` alone.

## 4. The plan editor can save a different day than the one on screen

Ledger lead A-05. Audit G04-F01.

Opening `/plan/B` while `/plan/A`'s prescription request is in flight applies
A's rows to B's editor. The save updates those rows. The person edits the day
they are looking at and changes the other one.

Done when: a late response cannot set state, and a save refuses a prescription
that does not belong to the workout on screen.

## 5. A failed plan write can stick, and the live training plan can disappear

Ledger A-84. Phase 2 names A-23 with it. Audit G08-F01, G08-F05, G01-F02.

`update_planned_workout` parks new rows, deletes the old ones, then moves the
parked rows one update at a time. A failure leaves parked positions, and the
retry inserts those positions again and the unique key rejects it. The day
cannot be edited. `set_training_plan` supersedes the live plan before the new
one is inserted. If phase insert fails and the restore fails, there is no live
plan. The catch also hard-deletes the partial revision. A skip that references
a prescription makes the prescription delete abort (`user_id` is `NOT NULL`
under `ON DELETE SET NULL`), which is one way to hit the parked-row failure.

Done when: each of those writes is one database function; failure leaves the
previous day or the previous live plan readable; retry does not collide; a
prescription referenced by a skip can be detached without nulling `user_id`.

## 6. Plan and Session can describe different workouts

Audit G08-F02. The plan editor gathers a superset by letter across the whole
day. The session only pairs neighbors. MCP accepts a group that is not
contiguous. The lifter reviews one pairing and performs another.

Done when: one fixture is rejected by MCP if the group is split, and Plan and
Session render an accepted group the same way. Section edits have to be in
this change: they are several requests, and a failure halfway leaves the
stored day different from the editor (G04-F04).

## 7. The phone can hide a live program

Ledger lead A-162. Audit G04-F03.

`getPlannedWorkouts` returns every confirmed program. `Today` keeps the
newest and drops the rest. A second confirmed program, which MCP can create
and which has already happened to a real plan, is absent from the calendar.
Those days cannot be started or edited on the phone.

Done when: each live program's dated days are reachable, and choosing one
does not drop the other from the data already loaded.

## 8. The release receipt can certify the wrong build

Ledger A-135, marked `fixed with test`, production proof still the receipt
line. Audit G13-F02.

The Pages job prints `receipt sha=<github.sha>` after HTTP 200. It does not
read a build id from the served HTML. A stale site, or the wrong `PAGES_URL`,
still produces the line the ledger treats as proof.

Done when: smoke compares an id in the served app to `github.sha` and does
not print a receipt on mismatch.

## Do before friend beta, as decisions rather than code bugs

- **A-02.** Production `COACH_ALLOWED_USERS` is still `needs live proof`.
  Unset is a 503 in code. That does not prove the secret is set to the one
  intended user. Phase 0's exit is this proof.
- **Confirmed-plan deletion.** `delete_program` accepts
  `confirm_delete_confirmed` from the caller. Permanent MCP tokens are the
  beta's planning path. Either the server checks an approval the caller
  cannot forge, or the threat model stops saying a stolen bearer can only
  write unconfirmed junk. `docs/security.md` currently says the latter.
  The in-app coach already has the tool disabled.

## Explicitly not must-fix

Endurance sync (pagination, corrections, checkpoints, bad payloads) is real
and has no PWA or MCP reader. It stays behind Phase 5. Unwired subjective
prompts, export field gaps, NaN on columns the phone cannot send, coach
content retention, push fanout, and the CI-billing exception (A-134, already
accepted) are not this list. Timed holds are unimplemented on both the plan
editor and the session logger; fix that before a live plan contains
`tracking: "time"`, not before the next logged squat.
