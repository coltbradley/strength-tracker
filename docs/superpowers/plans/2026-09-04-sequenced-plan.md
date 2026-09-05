# The plan of record, September 2026

Decisions made and work sequenced, from the 2026-09-04 audit (production data,
Sentry, four code audits, market research) and eval run 1.

This document is the ORDER and the DECISIONS. The task-level detail — exact
files, interfaces, test steps — lives in
[2026-09-04-gaps-roadmap.md](2026-09-04-gaps-roadmap.md), and the eval evidence
in [2026-09-04-coach-eval-run1.md](2026-09-04-coach-eval-run1.md). Where the two
disagree about ordering, this one wins.

Estimates are dev-days for one person working with Claude. They assume the
preflight in the roadmap runs on every task. Total is about **27 days**, but the
waves are independently shippable and the first two are what actually matter.

---

## Decision 1: the coach runs Claude Opus 5 at effort `low`

Change `supabase/functions/coach/index.ts:41` from `claude-sonnet-5` to
`claude-opus-5`. Leave `output_config: { effort: "low" }` exactly as it is.

**Why Opus.** The thing this model does that no other feature does is write to
someone's training plan. The failure that costs the most is not a mediocre
sentence, it is a wrong write — and side-effect error rate is the metric that
improves most reliably with model tier. Valentine's plan has already been
corrupted once. Cost is not a real constraint here: at her observed usage the
difference is about a dollar a month per person, and Anthropic's own guidance
for agent workloads is to start at Opus and only step down with evidence.

**Why `low` and not `medium`.** The effort setting was chosen deliberately for a
person standing at a rack between sets, and that reasoning still holds: her
turns already took 9 to 18 seconds. A stronger model at low effort is the
configuration that buys judgment without buying latency. Published results have
lower effort on a newer model matching or beating a weaker model at high effort,
and costing less per completed task because it needs fewer turns. Her worst turn
was 37 seconds of six sequential exercise lookups, which is a tool-loop problem,
not a thinking-depth problem.

**Why not raise effort to fix the memory misses.** Effort `low` does suppress
"go beyond the literal question", which is what calling `remember` is, so
raising it would probably help. But memory is being fixed properly in Wave 4 by
a deterministic extraction pass that does not depend on the model choosing to
remember. Fixing it with a setting that also costs latency, when a background
job fixes it for free, is the wrong trade.

**Why not Fable.** Twice the price of Opus for a chat where the hard problems
turned out to be tool-surface problems. Revisit only if Opus measurably fails a
judgment case in the API eval.

**Do this at the same time:** the monthly cap is denominated in tokens, so its
dollar value silently rises from about $20 to about $50 per user per month on
Opus. Drop `LIMIT_OUTPUT_TOKENS_PER_MONTH` from 2,000,000 to 800,000 to hold the
same real ceiling. Realistic usage is 30k to 200k, so this bites runaway loops
only.

**Confidence, and what would change my mind.** Moderate. Run 1 showed a
Sonnet-class model handling every judgment case where the prompt was clear, so
the model is not today's bottleneck and this change is insurance rather than a
fix. If the API eval (Wave 4, about $2) shows `sonnet-low` matching `opus-low`
on the judgment cases, go back to Sonnet and keep the money. The decision is
cheap to reverse; one constant.

## Decision 2: the two worst bugs are tool-surface work, not model work

Eval run 1 proved that adding a day to a confirmed program leaves two live
programs no matter which model drives, because `upsert_program` cannot touch a
confirmed program, and that an empty planned day cannot survive a wholesale
rewrite. Both are fixed by one new day-level tool and neither is affected by any
model or prompt change. That is why Wave 0 exists and why it comes before
everything, including the model swap.

## Decision 3: per-set RPE goes in, reversing the spec

`docs/spec.md` lists per-set subjective ratings as a non-goal. Reverse it, with
a decision entry. It is the third most-requested feature among coached lifters
in the research, it is what a coach autoregulates on, and it is one nullable
column plus a chip row that stays hidden until tapped. The non-goal was written
before the app had a coach reading the log. Wave 5.

## Decision 4: proposals are tapped, not typed

The coach proposes a day as a card with Apply and Change buttons; the write goes
through the PWA's own plan path on the tap. The spec's "approval in chat before
confirm" rule is satisfied by the tap, which is the same consent expressed in
one action instead of two turns. Set-level tweaks the coach may apply directly
with an Undo; anything that changes a day or a program proposes. This is the
reversibility split every comparable product uses, and mid-task confirmation
beat confirm-at-the-end in the one controlled study on it. Wave 4.

---

## Wave 0: stop corrupting a live user's data (2.75 days) — CODE DONE 2026-09-04

Valentine's calendar is wrong right now. Nothing else ships first.

| # | Work | Days | Status |
|---|---|---|---|
| 0a | `update_planned_workout` MCP tool: edit one day's prescriptions in place, on a confirmed program, without restating the rest. Coach prompt reaches for it and leaves `upsert_program` for genuinely new programs. | 1.5 | **done** (`edfda10`) |
| 0b | Plan editor writes `load_entry`. Both write paths resolve per-side the way the session screen does, show PER HAND, store the total. | 0.5 | **done** (`d3d606c`) |
| 0c | A planned day with no prescriptions is a draft, not a MISSED day. | 0.25 | **done** (`a84294c`) |
| 0d | Data repair for Valentine: soft-delete the duplicate program, double the dumbbell prescription loads and mark them `per_side`. | 0.5 | **blocked: her data, needs her yes** |

0a and 0b were verified against the eval: v12 and s01-swap went from failing to
passing every check, with one live program, all four days intact, and the swap
actually applied. 0b is covered by render tests over the sheet rather than by a
browser pass, because the dev server could not start in that session — Node
failed to resolve its own cwd in the preview harness, before any project code
ran. Worth a manual look next time someone has a working preview.

**None of it is deployed.** It needs, in this order: `supabase db push` for the
`exercise_count` view change, `supabase functions deploy mcp-server` and
`supabase functions deploy coach` for the new tool and the prompt, then a push
to main for the PWA. The migration goes first, or the app selects a column that
does not exist yet — the snag deploy.md already records.

Deploying 0a also makes 0d smaller: the duplicate program still needs a
decision, but her half-stored dumbbell loads become correctable in the app's own
plan editor instead of by hand in SQL.

## Wave 1: never lose or misfile a set (2.75 days)

The abandonment reason no feature outruns. All from the PWA audit.

| #   | Work                                                                                                                                                                                  | Days |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1a  | Offline open keeps you signed in, and a transient refresh failure stops dead-lettering the queue (roadmap 0.1). Reproduce first: expired token plus no network currently shows Login. | 1.0  |
| 1b  | Overnight reconciliation never discards a session another device may still be uploading (0.2).                                                                                        | 0.5  |
| 1c  | Today notices midnight, so a resumed app cannot start today's session against yesterday's planned day (0.3).                                                                          | 0.5  |
| 1d  | History stops resurrecting a removed set (0.4).                                                                                                                                       | 0.25 |
| 1e  | Rest-clock mirror when auto-start is off, and a failed bootstrap keeps the log button disabled instead of logging index 0 (0.7).                                                      | 0.5  |

## Wave 2: safe to run (2.75 days)

Cheap, bounded, and it protects the wallet and the other user. Ship as one
migration plus one edge deploy.

| #   | Work                                                                                                                                                          | Days |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 2a  | `coach_usage` insert errors are read; `turn_id` validated as a UUID before the turn starts. Closes the quota bypass that bills the owner's key without limit. | 0.5  |
| 2b  | Migration: drop `programs_delete`, `pw_delete`, `exercise_owners_delete`. Soft delete has been the only intended path since August.                           | 0.25 |
| 2c  | Per-turn coach tokens revoked in a `finally`, plus a weekly prune. 27 expired rows are sitting there.                                                         | 0.25 |
| 2d  | Close sign-up, or gate the coach on an allowlist. Open sign-up plus a per-user quota means any stranger with the URL gets 150 turns a day on the owner's key. | 0.25 |
| 2e  | `exercises.name` length and character limits; `update_exercise` disabled for the coach. A renamed shared exercise reaches every other user's model context.   | 0.5  |
| 2f  | Long turns return 413 instead of vanishing; `unit` whitelisted to kg/lb; attachment `kind`/`media_type`/`data` type-checked.                                  | 0.5  |
| 2g  | Sentry in both edge functions. Today a coach failure is invisible unless someone queries Supabase analytics, which was down during the audit.                 | 0.5  |

## Wave 3: the set loop (4.5 days)

Seconds-scale. This is what she touches every single session, and where the
research says apps are won or abandoned.

| #   | Work                                                                                                                                                                                                                                          | Days |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 3a  | Prescribed warmups actually work: prefill the bracket's `set_type`, count done-ness by working sets only, label warmup brackets in the target line. Half-wired since August.                                                                  | 1.0  |
| 3b  | A rest timer that gets attention on a locked iPhone: screen wake lock while a session is open, an audio cue unlocked on the LOG tap, and honest copy on the Rest alerts setting, which currently reports success for something iOS cannot do. | 1.0  |
| 3c  | Supersets hand you the partner after every log instead of only when the exercise is finished, and the rest strip waits for the last partner in the round.                                                                                     | 0.5  |
| 3d  | "Last time" shows the run (60 x 8, 8, 6), not one set.                                                                                                                                                                                        | 0.5  |
| 3e  | "Do this workout now" on any planned day, without rewriting its date.                                                                                                                                                                         | 0.5  |
| 3f  | Substitute an exercise mid-session: keeps the prescription link so adherence still credits the slot, changes the exercise so history records what was lifted. Valentine wrote this as prose twice.                                            | 1.0  |

## Wave 4: the coach earns its latency (5.25 days)

| #   | Work                                                                                                                                                                                                                     | Days |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 4a  | Model to `claude-opus-5`, cap to 800k, cache TTL to 5 minutes, and the whole week in the context block on non-session days. Every one of her turns opened with `get_program`.                                            | 0.5  |
| 4b  | Run the API eval to verify 4a: `sonnet-low` against `opus-low` on the judgment cases, one trial, about $2. Revert 4a if Sonnet matches.                                                                                  | 0.25 |
| 4c  | Deterministic memory: a Haiku pass after each turn extracts standing facts from the lifter's own words and writes them, off the response path. Shown back as a chip they can delete. Memory stops being a judgment call. | 1.5  |
| 4d  | Proposal cards with Apply / Change, per Decision 4.                                                                                                                                                                      | 2.0  |
| 4e  | Batch `resolve_exercises(names[])`, replacing six sequential lookups in a write turn.                                                                                                                                    | 0.5  |
| 4f  | Prompt: ask what they are avoiding after one rejected alternative; quote loads per hand; edit a day rather than rewrite a program.                                                                                       | 0.5  |

## Wave 5: what the coach asks about (6 days)

| #   | Work                                                                                                                                                                          | Days |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 5a  | Per-set RPE (Decision 3): migration, a 6.5 to 10 chip row hidden until tapped, carried through corrections and the MCP reads. Migration ships before the code that writes it. | 1.0  |
| 5b  | Bodyweight without a session: its own table and a one-line row on Today. Three sessions logged, zero bodyweights, because End is only seen if you tap Finish.                 | 1.0  |
| 5c  | sRPE reachable from Today's completed-session card for 24 hours, and the End draft persisted on change rather than on unmount.                                                | 0.5  |
| 5d  | PR feedback at the log tap: e1RM and rep PRs, toast, and the best point marked on the chart.                                                                                  | 1.0  |
| 5e  | A sessions view in History plus a weekly summary view and MCP tool. "What did I do Tuesday" currently needs the coach.                                                        | 1.5  |
| 5f  | Time-tracked work (`tracking = 'time'`) so planks and carries stop being ticks.                                                                                               | 1.0  |

## Wave 6: the second user, and the long tail (2.75 days)

| #   | Work                                                                                                                                                                                                                                                                               | Days |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 6a  | First run: a dismissable card that picks the unit, points at the coach, and says in one line that chats are logged. Plus a Resend button on Login, and the owner's name out of the coach's cap message.                                                                            | 0.75 |
| 6b  | The outbox is visible on the phone: dead items with their error, Retry, Export, and sign-out copy that matches what actually happens.                                                                                                                                              | 0.5  |
| 6c  | MCP gaps: `program_id` on `get_program` plus `list_programs`; `confirm_program` stops reporting a discarded program as already confirmed; `upsert_program` validates dates and caps lengths; `resolve_feedback` raises a tool error, not a 500; `search_exercises` handles quotes. | 1.0  |
| 6d  | Indexes on `set_voids`/`set_notes` by user, and a `since` predicate in `get_volume` so it stops aggregating all history on every call.                                                                                                                                             | 0.5  |

---

## Not doing, and why

Social features, badges, streaks, month grids and swipe gestures stay rejected;
the research is clear they are not why coached lifters stay. Video attached to a
set is a real coach want and a separate project. Cross-device settings stay
accepted as a limitation. Background rest notifications on iOS are not possible
from a web app, which is why 3b buys a wake lock and a sound instead. A native
app buys nothing here except the timer, and the offline story is the product.
Switching the coach off Anthropic would mean rebuilding the tool loop for a
model tier whose side-effect error rate is worse, which is the wrong direction
for something that writes to a plan; revisit above about 50 users.

## Sequencing logic, in one paragraph

Wave 0 first because a real person's calendar is wrong today and eval run 1
proved no amount of model or prompt work fixes it. Wave 1 next because losing a
logged set is the one failure that makes someone stop using a training log.
Wave 2 is small, and leaving an unbounded billing path and an open sign-up in
place while adding features is how a side project becomes an incident. Wave 3 is
the loop she touches every session, so it is the first wave that makes the app
feel better rather than merely correct. Wave 4 makes the coach worth its
latency, and it comes after Wave 3 because a faster coach does not help someone
whose rest timer never went off. Waves 5 and 6 are the difference between a log
that works and one worth keeping.
