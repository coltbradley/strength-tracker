-- What the coach actually did, so it can be improved and so a bad turn can be
-- reconstructed.
--
-- coach_usage started as a rate-limiting ledger. These columns make it the
-- record you would actually want when the coach says something wrong, when
-- the bill looks off, or when you need to know whether prompt caching is
-- still working (it fails silently; without cache_read_tokens there is no
-- way to notice).
alter table coach_usage add column cache_read_tokens  int not null default 0;
alter table coach_usage add column cache_write_tokens int not null default 0;
alter table coach_usage add column latency_ms         int;
alter table coach_usage add column tools_used         text[] not null default '{}';
alter table coach_usage add column stop_reason        text;
alter table coach_usage add column attachments        jsonb not null default '[]';

-- The conversation itself.
--
-- This is a different kind of data from everything above it and deserves to be
-- named as such: it is the lifter's private conversation with their coach, and
-- whoever runs the deployment can read it. That is a product decision, not a
-- technical one. It is on because the owner asked for it; the edge function
-- honours COACH_LOG_CONTENT=off, which writes NULL here and changes nothing
-- else. If a second person ever uses this deployment, they should be told.
alter table coach_usage add column prompt   text;
alter table coach_usage add column response text;

comment on column coach_usage.prompt is
  'The user''s message text for this turn, or NULL when COACH_LOG_CONTENT=off. '
  'Private conversation content — tell anyone else using the deployment that '
  'it is recorded.';
comment on column coach_usage.response is
  'The assistant''s answer for this turn, or NULL when COACH_LOG_CONTENT=off.';

-- Reading your own turns back is fine; the existing owner-only select policy
-- already covers it. There is still no client insert or update path: the edge
-- function writes with the service role, and a client that could write its own
-- usage rows could also decline to.
