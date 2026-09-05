-- Memory that is extracted rather than remembered, and what that costs.
--
-- The coach never called `remember` in a real 13-turn conversation, twice over
-- in the eval, with two different models. So a second, cheap pass now reads
-- each turn after it is answered and writes the standing facts the lifter
-- actually said (supabase/functions/coach/memory-extract.ts). Two things have
-- to exist in the database for that to be honest.

-- 1. A usage row that is NOT a message.
--
-- coach_usage is two things at once: an itemised record of spend, and the
-- ledger both quotas are counted from. The extraction pass spends real money
-- on the deployment owner's key, so it has to appear here — but it is not
-- something the lifter sent, and the daily cap counts ROWS (150 messages a
-- day). Without this column an extraction would eat a message, silently
-- halving everyone's allowance the day it deployed.
--
-- The monthly cap is the other half of the answer and needs no column: it sums
-- TOKENS across every row, which is exactly right, because a token spent
-- extracting is the same money as a token spent answering.
--
-- Defaulted so the turn's own insert never names it. That matters for the
-- deploy order: this migration can land before the function that writes
-- 'extraction', and every row written in between is correctly a turn.
alter table coach_usage
  add column kind text not null default 'turn'
    check (kind in ('turn', 'extraction'));

comment on column coach_usage.kind is
  'turn = a message the lifter sent and the answer to it. extraction = the '
  'memory-extraction pass that runs after a turn, on a cheaper model. Both '
  'count toward the monthly TOKEN cap; only ''turn'' counts toward the daily '
  'message cap, because an extraction is not something anybody sent.';

-- Extraction rows never carry a turn_id: coach_usage has a unique index on it
-- and the turn's own row already holds that id. Finding this row instead would
-- make the "already answered" check answer 409 to a question nobody asked.
-- This index is what makes the day-window count cheap now that it is filtered.
create index idx_coach_usage_kind_time on coach_usage (user_id, kind, created_at desc);

-- The two cost views have to learn the same distinction, or "turns today"
-- doubles the moment extraction ships. Columns are appended, never reordered:
-- create or replace view only tolerates additions at the end.
--
-- Pricing is untouched and remains the stale Sonnet 5 table the view has
-- always used, which already misprices the Opus turns it reads. Re-pricing per
-- model is a real change and a separate one; this migration must not smuggle
-- it in under a memory feature.
create or replace view v_coach_cost with (security_invoker = true) as
select
  id, user_id, created_at, model, latency_ms, tools_used, stop_reason, refused,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  round(
    ( input_tokens       * 2.00
    + output_tokens      * 10.00
    + cache_write_tokens * 2.50
    + cache_read_tokens  * 0.20
    ) / 1000000.0
  , 6) as cost_usd,
  kind
from coach_usage;

create or replace view v_coach_spend_daily with (security_invoker = true) as
select
  user_id,
  (created_at at time zone app_tz(user_id))::date as day,
  count(*) filter (where refused is null and kind = 'turn') as turns,
  sum(input_tokens)  as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cache_read_tokens) as cache_read_tokens,
  round(sum(cost_usd), 4) as cost_usd
from v_coach_cost
group by user_id, (created_at at time zone app_tz(user_id))::date;

-- 2. A fact that can say where it came from.
--
-- Memory the lifter never asked for has to be showable back to them as
-- something they can delete, or it is a model quietly building a file on
-- someone. The row already carried everything needed to DISPLAY it; what was
-- missing was provenance, so the app cannot tell a fact the lifter dictated
-- from one a model picked up.
--
-- `source` carries exactly ONE fact and must keep carrying one: how this row
-- got here. Nothing may branch on it for ownership or permission — that is the
-- mistake `exercises.source` made, where "which seed owns this" and "is this
-- private" rode on one column until a re-tag made a row readable by nobody.
-- Ownership here is user_id and only user_id.
alter table coach_memory
  add column source text not null default 'coach'
    check (source in ('coach', 'extracted'));

comment on column coach_memory.source is
  'coach = written by a `remember` tool call, so the lifter was told about it '
  'in the conversation. extracted = picked up by the post-turn extraction '
  'pass, so nobody has mentioned it to them yet and the app owes them a way to '
  'see and delete it. Display and audit only: never a permission or ownership '
  'test.';

-- Which turn taught us this. Lets the app show the new facts alongside the
-- answer they came from, and lets an operator find the message behind a fact
-- that looks wrong.
--
-- Deliberately no foreign key to coach_usage: turn_id there is nullable and
-- its unique index is partial, so it cannot back one, and a fact must outlive
-- any pruning of the usage ledger anyway. Null means the client sent no turn
-- id, or the fact came from a `remember` call.
alter table coach_memory add column source_turn_id uuid;

comment on column coach_memory.source_turn_id is
  'The client-chosen turn_id of the message this fact was extracted from. Not '
  'a foreign key: coach_usage.turn_id is nullable with a partial unique index, '
  'and a standing fact outlives the usage row either way.';
