-- Per-set RPE, which spec.md listed as a non-goal.
--
-- Reversing that is a deliberate decision (docs/decisions.md). The non-goal was
-- written before the app had a coach reading the log, and RPE is the number a
-- coach autoregulates on: "8s at RPE 9" and "8s at RPE 6" are the same row
-- today and opposite instructions in practice. It stays OPTIONAL and one tap,
-- because the set loop is measured in seconds and a required field on it is how
-- people stop logging.
--
-- Nullable forever. A set logged without RPE is not incomplete, it is a set
-- someone did not rate, and nothing downstream may require it.

alter table sets
  add column rpe numeric(3,1)
  check (
    rpe is null
    -- Below 5 is noise: nobody usefully distinguishes a 3 from a 4 in
    -- retrospect, and the chip row starts at 6.5 for the same reason.
    or (
      rpe between 5 and 10
      -- Half points only. The scale coaches actually use is 6.5, 7, 7.5, and
      -- an arbitrary 7.3 would be a fake precision no view could interpret.
      and rpe * 2 = trunc(rpe * 2)
    )
  );

comment on column sets.rpe is
  'How hard the set felt, 5 to 10 in half points. Null means unrated, which is '
  'the normal case and never an error: rating is one optional tap and `sets` '
  'is append-only, so a set logged without it can only be rated by voiding and '
  'relogging. Nothing derived may require it.';

-- v_live_sets is `select s.*`, expanded at creation time, so it does not pick
-- up a new `sets` column on its own. Replacing it appends rpe and every
-- dependent view (v_e1rm, v_weekly_volume, v_adherence, v_rest,
-- v_session_best_e1rm, v_goal_progress) follows without changing meaning:
-- none of them select *, and none of them filter or aggregate on rpe.
create or replace view v_live_sets with (security_invoker = true) as
select s.*
from sets s
join sessions ss on ss.id = s.session_id
where ss.discarded_at is null
  and not exists (
    select 1 from set_voids v
    where v.set_id = s.id and v.user_id = s.user_id
  );
