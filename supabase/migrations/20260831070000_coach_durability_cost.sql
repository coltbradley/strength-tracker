-- Two things the coach was missing: an answer that survives the app closing,
-- and a number for what any of it costs.

-- 1. A turn has an id the CLIENT chose.
--
-- Someone asks a question mid-session, locks the phone, and comes back. The
-- browser's fetch is gone; the answer is not, because the function finishes
-- the turn regardless and writes it here. On reopen the app looks the turn up
-- by the id it generated and fills in what it missed.
--
-- Client-generated, like sets and sessions ids, for the same reason: the
-- client has to know the id BEFORE the round trip, or it has nothing to ask
-- for afterwards.
alter table coach_usage add column turn_id uuid;

create unique index idx_coach_usage_turn on coach_usage (turn_id)
  where turn_id is not null;

comment on column coach_usage.turn_id is
  'Client-generated id for one question. Lets the app recover an answer it '
  'was not connected for — the function completes and records every turn '
  'whether or not anyone is still listening.';

-- 2. What it cost.
--
-- Tokens were already recorded; nobody reads tokens. Rates are Claude Sonnet 5
-- list price as of 2026-08: $2/MTok input, $10/MTok output, cache writes at
-- 1.25x input, cache reads at 0.1x. Kept in the view rather than a stored
-- column so re-pricing is one CREATE OR REPLACE and never a backfill that
-- rewrites history.
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
  , 6) as cost_usd
from coach_usage;

-- Per user per day, which is the shape anyone actually asks for ("what is this
-- costing me"). Rolled up in SQL so a client never pages the whole ledger.
create or replace view v_coach_spend_daily with (security_invoker = true) as
select
  user_id,
  (created_at at time zone app_tz(user_id))::date as day,
  count(*) filter (where refused is null) as turns,
  sum(input_tokens)  as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cache_read_tokens) as cache_read_tokens,
  round(sum(cost_usd), 4) as cost_usd
from v_coach_cost
group by user_id, (created_at at time zone app_tz(user_id))::date;
