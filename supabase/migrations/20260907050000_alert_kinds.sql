-- Alerts learn what they are for.
--
-- `rest_alerts` was built for one thing and its shape says so: no kind column,
-- and the schedule endpoint cancels the user's OTHER open alert on the way in,
-- because one person can only be resting once. E1 adds three more reasons to
-- buzz a phone -- the morning panel, the weekly OSTRC, and the pain check the
-- morning after a run -- and every one of those assumptions breaks:
--
--   * A daily prompt scheduled for 07:00 would CANCEL a rest alert armed at
--     06:58, and vice versa. The "one live alert" rule is right per KIND and
--     wrong across kinds.
--   * The service worker tags every notification `rest`, which is what makes a
--     backlog collapse into one buzz. Across kinds that same mechanism makes a
--     check-in prompt REPLACE a rest alert on the lock screen, silently.
--
-- So: a kind on the row, defaulting to 'rest' so every existing alert keeps
-- its meaning and nothing needs backfilling.
alter table rest_alerts
  add column kind text not null default 'rest'
    check (kind in ('rest','daily_readiness','ostrc_weekly','next_morning_pain'));

comment on column rest_alerts.kind is
  'What this alert is for. Defaults to rest, which is what every row predating '
  'this column is. The one-live-alert rule the schedule endpoint enforces is '
  'per (user, kind): a morning check-in prompt must not cancel a rest timer, '
  'and the service worker tags notifications by kind for the same reason.';

comment on table rest_alerts is
  'One row per scheduled push. Named for the only kind that existed when it '
  'was created; it now carries every kind (see kind). Not renamed, because a '
  'table rename is a breaking change to every deployed function for the sake '
  'of a word.';

-- The open-alert index gains the kind, since every lookup is now per kind.
drop index if exists idx_rest_alerts_open;
create index idx_rest_alerts_open
  on rest_alerts (user_id, kind, fire_at)
  where sent_at is null and cancelled_at is null;
