-- Cost is priced per MODEL, because there are now two of them.
--
-- v_coach_cost has always multiplied tokens by Claude Sonnet 5 list price,
-- which was right when Sonnet was the only model this deployment called. It
-- stopped being right twice over: the coach runs claude-opus-5, and every turn
-- is followed by a memory-extraction pass on Haiku. A single rate table
-- underpriced the turns by a factor of about 2.5 and overpriced the
-- extractions by about 2, which is the worst way for a cost view to be wrong:
-- the two errors partly cancel, so the total looks plausible.
--
-- Rates are list price as of 2026-09, per million tokens, with cache writes at
-- 1.25x input and cache reads at 0.1x:
--
--     opus-5     $5 in   $25 out
--     sonnet-5   $2 in   $10 out
--     haiku-4.5  $1 in    $5 out
--
-- Matched on a PREFIX of the recorded model string, so a dated snapshot id
-- (claude-haiku-4-5-20251001) prices the same as the bare alias. An unknown
-- model yields NULL rather than a guess: a null in a cost column is a question
-- somebody asks, and a plausible number computed from the wrong rate is one
-- nobody ever asks. Every consumer already aggregates with sum(), which skips
-- nulls, so an unpriced row cannot silently inflate a total either.
--
-- Still a view and not a stored column, for the reason it always was:
-- re-pricing is one CREATE OR REPLACE, never a backfill that rewrites history.

create or replace view v_coach_cost with (security_invoker = true) as
with rate as (
  select
    c.id,
    case
      when c.model like 'claude-opus-5%'   then 5.00
      when c.model like 'claude-sonnet-5%' then 2.00
      when c.model like 'claude-haiku-4-5%' then 1.00
    end as in_rate,
    case
      when c.model like 'claude-opus-5%'   then 25.00
      when c.model like 'claude-sonnet-5%' then 10.00
      when c.model like 'claude-haiku-4-5%' then 5.00
    end as out_rate
  from coach_usage c
)
select
  c.id, c.user_id, c.created_at, c.model, c.latency_ms, c.tools_used,
  c.stop_reason, c.refused,
  c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_tokens,
  round(
    ( c.input_tokens       * r.in_rate
    + c.output_tokens      * r.out_rate
    + c.cache_write_tokens * r.in_rate * 1.25
    + c.cache_read_tokens  * r.in_rate * 0.10
    ) / 1000000.0
  , 6) as cost_usd,
  c.kind
from coach_usage c
join rate r on r.id = c.id;

comment on view v_coach_cost is
  'One row per recorded coach call with its cost in USD, priced from the model '
  'string it recorded. cost_usd is NULL for a model this view has no rate for, '
  'which is deliberate: an unpriced row should be a question, not a plausible '
  'wrong number. kind tells a lifter''s message apart from the extraction pass '
  'that follows it.';
