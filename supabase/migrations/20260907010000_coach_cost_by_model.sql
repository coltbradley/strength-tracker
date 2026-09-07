-- The cost view charged one model's rates for whatever ran.
--
-- `v_coach_cost` was written when the coach was Sonnet 5 and hard-coded its
-- list price: $2/MTok in, $10/MTok out, cache writes at 1.25x, reads at 0.1x.
-- The coach then moved to Opus 5 and the view did not, so every turn since has
-- been reported at 40% of what it actually cost. Nobody noticed, because the
-- number looked plausible and there was nothing to compare it against. The
-- coach has now moved back to Sonnet 5, which makes the view accidentally
-- correct again for new rows and still wrong for every Opus row in the table.
--
-- Rates belong beside the model that incurred them. `model` is already on every
-- `coach_usage` row, so the fix is to price by it and let history reprice
-- itself: an Opus turn recorded last week becomes correctly expensive the
-- moment this lands, with no backfill and no rewritten row. That is the same
-- reason the rates lived in a view rather than a stored column in the first
-- place; the original just stopped one step short of using the column it had.
--
-- An UNKNOWN model prices as NULL, not as a guess. A wrong number is worse than
-- a missing one here: the whole point of this ledger is to answer "what is this
-- costing me", and a plausible-looking understatement is exactly the failure
-- being fixed. Because `sum()` skips nulls, a null would quietly shrink the
-- daily total in the same way, so `v_coach_spend_daily` now carries
-- `unpriced_turns` beside the money. A total with a non-zero count next to it
-- is a total someone can distrust on purpose.
--
-- Rates are Anthropic list prices as of 2026-09. Cache writes are 1.25x input
-- and cache reads 0.1x input on both models, so those columns are derived from
-- the input rate rather than typed out and left to drift.
create or replace view v_coach_cost with (security_invoker = true) as
with rates as (
  select
    u.id,
    case u.model
      when 'claude-sonnet-5' then 2.00
      when 'claude-opus-5'   then 5.00
    end as in_rate,
    case u.model
      when 'claude-sonnet-5' then 10.00
      when 'claude-opus-5'   then 25.00
    end as out_rate
  from coach_usage u
)
select
  u.id, u.user_id, u.created_at, u.model, u.latency_ms, u.tools_used,
  u.stop_reason, u.refused,
  u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
  round(
    ( u.input_tokens       * r.in_rate
    + u.output_tokens      * r.out_rate
    + u.cache_write_tokens * r.in_rate * 1.25
    + u.cache_read_tokens  * r.in_rate * 0.10
    ) / 1000000.0
  , 6) as cost_usd
from coach_usage u
join rates r on r.id = u.id;

comment on view v_coach_cost is
  'One row per coach turn with its cost, priced by the model that ran it. '
  'cost_usd is NULL for a model this view has no rates for: adding a model to '
  'the coach means adding its rates here, and until that happens the turn is '
  'reported as unpriced rather than as cheap.';

-- The rollup gains the count it needs to admit an incomplete total.
create or replace view v_coach_spend_daily with (security_invoker = true) as
select
  user_id,
  (created_at at time zone app_tz(user_id))::date as day,
  count(*) filter (where refused is null) as turns,
  sum(input_tokens)  as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cache_read_tokens) as cache_read_tokens,
  round(sum(cost_usd), 4) as cost_usd,
  -- Appended, not inserted: `create or replace view` may only add columns at
  -- the END, and an existing select that does not name this one is unaffected.
  count(*) filter (where refused is null and cost_usd is null) as unpriced_turns
from v_coach_cost
group by user_id, (created_at at time zone app_tz(user_id))::date;

comment on view v_coach_spend_daily is
  'Coach spend per user per day. unpriced_turns counts turns whose model has '
  'no rates in v_coach_cost; cost_usd excludes them, so a non-zero count means '
  'the total is a floor rather than an answer.';
