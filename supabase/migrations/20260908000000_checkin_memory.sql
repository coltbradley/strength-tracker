-- The passive check-in feeds memory the same way a coach turn does.
--
-- The morning three-scale panel is being replaced by a single always-available
-- "Check in" entry point: free text plus mood chips, saved as a `checkins` row
-- (kind 'spontaneous'). Those notes are exactly the kind of standing-fact
-- material memory-extract.ts already pulls from a coach turn -- "shoulder's
-- been cranky", "traveling this week, only have bands" -- except nobody is
-- having a conversation for it to ride along on. So a second, small extraction
-- pass reads check-in notes directly, on the same model and the same rules
-- (lifter's own words only, deduped against existing memory).

-- WHICH ROWS HAVE BEEN READ. A boolean would work for "has this been looked
-- at" but not for "was it looked at with the memory that existed AT THE TIME"
-- -- not needed here, since extraction is idempotent-by-dedupe regardless, but
-- a timestamp costs nothing extra and answers "when" for free if this is ever
-- debugged from the data alone. Service-written: nothing in this table's RLS
-- changes, because the extraction route runs as the service role (like every
-- other write coach_memory receives) and a lifter typing in the sheet has no
-- reason to touch it.
alter table checkins add column memory_extracted_at timestamptz;

comment on column checkins.memory_extracted_at is
  'Stamped by the coach function''s checkin-memory extraction pass once this '
  'row''s note has been read for standing facts. NULL means not yet '
  'processed. Never set by the PWA.';

-- Widen source to admit a fact that came from a check-in note rather than a
-- conversation turn. Still exactly one fact per row (provenance, never
-- ownership or permission) -- see the comment on the column itself, which this
-- migration does not touch.
alter table coach_memory drop constraint coach_memory_source_check;
alter table coach_memory add constraint coach_memory_source_check
  check (source in ('coach', 'extracted', 'checkin'));

comment on column coach_memory.source is
  'coach = written by a `remember` tool call, so the lifter was told about it '
  'in the conversation. extracted = picked up by the post-turn extraction '
  'pass, so nobody has mentioned it to them yet. checkin = picked up from a '
  'check-in note by the same pass, run out of band. Display and audit only: '
  'never a permission or ownership test.';
