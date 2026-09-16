-- Set and session notes feed memory extraction through the same out-of-band
-- pattern check-ins already use (20260908000000_checkin_memory.sql).
--
-- A set note ("knee felt off on the last two") or a session note is exactly
-- the kind of standing-fact material memory-extract.ts already pulls from a
-- coach turn, except the lifter typed it while logging, not while talking to
-- the coach. Two columns track which rows a new out-of-band pass has already
-- read, mirroring checkins.memory_extracted_at exactly: a timestamp rather
-- than a boolean so "when" is answered for free if this is ever debugged from
-- the data alone, even though extraction is idempotent-by-dedupe regardless.
-- Service-written: nothing in either table's RLS changes, since the
-- extraction route runs as the service role, like every other coach_memory
-- write, and neither the PWA nor the lifter has a reason to touch these.

alter table set_notes add column memory_extracted_at timestamptz;

comment on column set_notes.memory_extracted_at is
  'Stamped by the coach function''s note-memory extraction pass once this '
  'note has been read for standing facts. NULL means not yet processed. '
  'Never set by the PWA. set_notes stays editable (last-write-wins); an edit '
  'after extraction leaves this stamp in place; a future pass may re-read '
  'notes changed since their memory_extracted_at, but that policy lives in '
  'the extraction route, not here.';

alter table sessions add column notes_memory_extracted_at timestamptz;

comment on column sessions.notes_memory_extracted_at is
  'Stamped by the coach function''s note-memory extraction pass once '
  'sessions.notes has been read for standing facts. NULL means not yet '
  'processed, including every session with no notes at all. Never set by '
  'the PWA.';

-- Widen source to admit a fact picked up from a set or session note rather
-- than a conversation turn or a check-in. Still exactly one fact per row
-- (provenance, never ownership or permission) — see the comment on the
-- column itself, which this migration does not touch.
alter table coach_memory drop constraint coach_memory_source_check;
alter table coach_memory add constraint coach_memory_source_check
  check (source in ('coach', 'extracted', 'checkin', 'set_note'));
