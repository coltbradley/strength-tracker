-- A daily total that can admit it is incomplete.
--
-- This file arrived from the endurance branch as `coach_cost_by_model`, and
-- most of what it did has already happened: `20260906060000` reprices
-- `v_coach_cost` per model and is applied in production. Two sessions solved
-- the same problem in parallel. What did NOT already exist, and is the better
-- idea of the two, is this: a rollup that says how much of itself is missing.
--
-- `cost_usd` is NULL for a model `v_coach_cost` has no rates for, deliberately,
-- because a plausible number computed from the wrong rate is one nobody ever
-- questions. But `sum()` skips nulls, so an unpriced row shrinks the daily
-- total just as quietly. `unpriced_turns` beside the money is what makes the
-- total distrustable on purpose: a non-zero count means `cost_usd` is a floor
-- rather than an answer.
--
-- The original version of this migration could not be applied as written. It
-- rebuilt `v_coach_cost` from scratch without the `kind` column that
-- `20260906050000` had added, and `create or replace view` may only APPEND
-- columns — Postgres rejects it with "cannot drop columns from view". Against
-- a database that already had the memory-extraction round, and production did,
-- the whole chain stopped there. Rewriting rather than renumbering is safe
-- because this migration has never been applied anywhere; the append-only rule
-- governs migrations that have RUN.
--
-- Two things from that version are deliberately not carried over:
--
--   * Its rate table matched the model with `case model when 'claude-opus-5'`,
--     exact equality. Every dated snapshot id prices NULL under that, and the
--     memory-extraction pass runs on `claude-haiku-4-5-20251001`, so every
--     extraction row would have been unpriced — and would then have dominated
--     the very counter this migration adds. `20260906060000` matches on a
--     prefix and carries a haiku rate, so it is left alone.
--   * Its rollup counted `turns` without the `kind = 'turn'` filter. That
--     filter is load-bearing: the daily cap counts MESSAGES, and without it the
--     post-turn extraction pass eats one, halving everyone's 150/day allowance.

create or replace view v_coach_spend_daily with (security_invoker = true) as
select
  user_id,
  (created_at at time zone app_tz(user_id))::date as day,
  -- `kind = 'turn'` stays. An extraction is money (it belongs in the token
  -- sums below) but it is not something anybody sent, and this is the number
  -- the daily message cap reads.
  count(*) filter (where refused is null and kind = 'turn') as turns,
  sum(input_tokens)  as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cache_read_tokens) as cache_read_tokens,
  round(sum(cost_usd), 4) as cost_usd,
  -- Appended, not inserted: `create or replace view` may only add columns at
  -- the END, and an existing select that does not name this one is unaffected.
  -- That constraint is exactly what this migration exists to respect.
  --
  -- Counted over the SAME population as `turns`, filter for filter. Counting
  -- unpriced rows across every kind while `turns` counted only messages would
  -- allow "turns 5, unpriced_turns 7", which reads as a broken ledger rather
  -- than an incomplete one.
  count(*) filter (
    where refused is null and kind = 'turn' and cost_usd is null
  ) as unpriced_turns
from v_coach_cost
group by user_id, (created_at at time zone app_tz(user_id))::date;

comment on view v_coach_spend_daily is
  'Coach spend per user per day. turns counts only kind = ''turn'', because '
  'that is what the daily message cap limits; the token sums include the '
  'extraction pass, because that is real money. unpriced_turns counts turns '
  'whose model has no rates in v_coach_cost, over the same population as '
  'turns: cost_usd excludes them, so a non-zero count means the total is a '
  'floor rather than an answer.';
