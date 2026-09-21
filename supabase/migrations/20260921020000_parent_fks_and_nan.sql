-- A-03: composite (parent_id, user_id) FKs so a child cannot name another
-- owner's parent row. A-49: CHECK (col = col) rejects NaN on load/weight numerics.
--
-- Parent uniques (id is already PK; Postgres needs the two-column unique for
-- composite FK targets): programs, planned_workouts, prescriptions, sessions,
-- sets, symptom_episodes.

alter table programs add constraint programs_id_user unique (id, user_id);
alter table planned_workouts add constraint planned_workouts_id_user unique (id, user_id);
alter table prescriptions add constraint prescriptions_id_user unique (id, user_id);
alter table sessions add constraint sessions_id_user unique (id, user_id);
alter table sets add constraint sets_id_user unique (id, user_id);
alter table symptom_episodes add constraint symptom_episodes_id_user unique (id, user_id);

-- Child FKs (constraint names from \d on a fresh schema.sql install).

alter table planned_workouts
  drop constraint planned_workouts_program_id_fkey,
  add constraint planned_workouts_program_user_fkey
    foreign key (program_id, user_id) references programs (id, user_id)
    on delete cascade;

alter table prescriptions
  drop constraint prescriptions_planned_workout_id_fkey,
  add constraint prescriptions_planned_workout_user_fkey
    foreign key (planned_workout_id, user_id) references planned_workouts (id, user_id)
    on delete cascade;

alter table sessions
  drop constraint sessions_planned_workout_id_fkey,
  add constraint sessions_planned_workout_user_fkey
    foreign key (planned_workout_id, user_id) references planned_workouts (id, user_id)
    on delete set null;

alter table sets
  drop constraint sets_session_id_fkey,
  drop constraint sets_prescription_id_fkey,
  add constraint sets_session_user_fkey
    foreign key (session_id, user_id) references sessions (id, user_id)
    on delete cascade,
  add constraint sets_prescription_user_fkey
    foreign key (prescription_id, user_id) references prescriptions (id, user_id)
    on delete set null;

alter table set_voids
  drop constraint set_voids_set_id_fkey,
  add constraint set_voids_set_user_fkey
    foreign key (set_id, user_id) references sets (id, user_id)
    on delete cascade;

alter table set_notes
  drop constraint set_notes_set_id_fkey,
  add constraint set_notes_set_user_fkey
    foreign key (set_id, user_id) references sets (id, user_id)
    on delete cascade;

alter table session_skips
  drop constraint session_skips_session_id_fkey,
  drop constraint session_skips_prescription_id_fkey,
  add constraint session_skips_session_user_fkey
    foreign key (session_id, user_id) references sessions (id, user_id),
  add constraint session_skips_prescription_user_fkey
    foreign key (prescription_id, user_id) references prescriptions (id, user_id)
    on delete set null;

alter table checkins
  drop constraint checkins_session_id_fkey,
  add constraint checkins_session_user_fkey
    foreign key (session_id, user_id) references sessions (id, user_id)
    on delete set null;

alter table pain_checks
  drop constraint pain_checks_session_id_fkey,
  add constraint pain_checks_session_user_fkey
    foreign key (session_id, user_id) references sessions (id, user_id)
    on delete set null;

alter table symptom_reports
  drop constraint symptom_reports_episode_id_fkey,
  add constraint symptom_reports_episode_user_fkey
    foreign key (episode_id, user_id) references symptom_episodes (id, user_id)
    on delete cascade;

alter table activities
  drop constraint activities_planned_workout_id_fkey,
  add constraint activities_planned_workout_user_fkey
    foreign key (planned_workout_id, user_id) references planned_workouts (id, user_id)
    on delete set null;

-- NaN: col = col alone is always true for PostgreSQL numeric; pairing it with
-- the column's finite precision ceiling rejects NaN (NaN <= max is false).
alter table sets add constraint sets_load_kg_not_nan check (load_kg = load_kg and load_kg <= 9999.99);
alter table prescriptions add constraint rx_load_kg_not_nan
  check (load_kg is null or (load_kg = load_kg and load_kg <= 9999.99));
alter table prescriptions add constraint rx_load_pct_tm_not_nan
  check (load_pct_tm is null or (load_pct_tm = load_pct_tm and load_pct_tm <= 200));
alter table training_maxes add constraint tm_value_kg_not_nan check (value_kg = value_kg and value_kg <= 9999.99);
alter table bodyweight_log add constraint bw_weight_kg_not_nan check (weight_kg = weight_kg and weight_kg <= 999.99);
alter table sessions add constraint sessions_bodyweight_kg_not_nan
  check (bodyweight_kg is null or (bodyweight_kg = bodyweight_kg and bodyweight_kg <= 999.99));
