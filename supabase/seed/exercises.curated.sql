-- Curated additions to the free-exercise-db seed: modern machines on a
-- commercial gym floor (Live Fit Castro), specialty barbell work, unilateral
-- and anti-rotation accessories, and runner/climber staples the upstream
-- library lacks. Hand-maintained — add rows here (source='curated') or via
-- the MCP add_exercise tool (source='custom').
-- Idempotent: upserts on id, never touches rows with any other source.
insert into exercises
  (id, name, primary_muscles, secondary_muscles, equipment, mechanic, force, category, level, source)
values
-- Squat patterns: specialty bars, tempo work, machines --------------------
('Safety_Bar_Squat', 'Safety Bar Squat', array['quadriceps']::text[], array['glutes', 'hamstrings', 'lower back']::text[], 'barbell', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('Paused_Squat', 'Paused Squat', array['quadriceps']::text[], array['glutes', 'hamstrings']::text[], 'barbell', 'compound', 'push', 'powerlifting', 'intermediate', 'curated'),
('Tempo_Squat', 'Tempo Squat', array['quadriceps']::text[], array['glutes', 'hamstrings']::text[], 'barbell', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('Heel_Elevated_Squat', 'Heel Elevated Squat', array['quadriceps']::text[], array['glutes']::text[], 'barbell', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Belt_Squat', 'Belt Squat (Machine)', array['quadriceps']::text[], array['glutes', 'hamstrings']::text[], 'machine', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('Pendulum_Squat', 'Pendulum Squat (Machine)', array['quadriceps']::text[], array['glutes']::text[], 'machine', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('V_Squat_Machine', 'V-Squat Machine', array['quadriceps']::text[], array['glutes']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Single_Leg_Leg_Press', 'Single Leg Leg Press', array['quadriceps']::text[], array['glutes', 'hamstrings']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Wall_Sit', 'Wall Sit', array['quadriceps']::text[], array['glutes']::text[], 'body only', 'isolation', 'static', 'strength', 'beginner', 'curated'),
('Spanish_Squat', 'Spanish Squat', array['quadriceps']::text[], '{}'::text[], 'bands', 'compound', 'push', 'strength', 'beginner', 'curated'),

-- Single-leg squat/lunge family -------------------------------------------
('Bulgarian_Split_Squat', 'Bulgarian Split Squat', array['quadriceps']::text[], array['glutes', 'hamstrings', 'adductors']::text[], 'dumbbell', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('Barbell_Bulgarian_Split_Squat', 'Barbell Bulgarian Split Squat', array['quadriceps']::text[], array['glutes', 'hamstrings']::text[], 'barbell', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('ATG_Split_Squat', 'ATG Split Squat', array['quadriceps']::text[], array['glutes', 'hamstrings']::text[], 'body only', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('Cossack_Squat', 'Cossack Squat', array['adductors']::text[], array['quadriceps', 'glutes']::text[], 'body only', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('Curtsy_Lunge', 'Curtsy Lunge', array['glutes']::text[], array['quadriceps', 'adductors']::text[], 'dumbbell', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Skater_Squat', 'Skater Squat', array['quadriceps']::text[], array['glutes']::text[], 'body only', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('Shrimp_Squat', 'Shrimp Squat', array['quadriceps']::text[], array['glutes']::text[], 'body only', 'compound', 'push', 'strength', 'expert', 'curated'),
('Poliquin_Step_Up', 'Poliquin Step-Up', array['quadriceps']::text[], array['calves']::text[], 'body only', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Lateral_Step_Down', 'Lateral Step-Down', array['quadriceps']::text[], array['glutes']::text[], 'body only', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Box_Step_Down', 'Box Step-Down', array['quadriceps']::text[], array['glutes', 'calves']::text[], 'body only', 'compound', 'push', 'strength', 'beginner', 'curated'),

-- Hinge: unilateral, specialty, machines ----------------------------------
('Single_Leg_Romanian_Deadlift', 'Single Leg Romanian Deadlift', array['hamstrings']::text[], array['glutes', 'lower back', 'abductors']::text[], 'dumbbell', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('Barbell_Single_Leg_Romanian_Deadlift', 'Barbell Single Leg Romanian Deadlift', array['hamstrings']::text[], array['glutes', 'lower back']::text[], 'barbell', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('B_Stance_Romanian_Deadlift', 'B-Stance Romanian Deadlift', array['hamstrings']::text[], array['glutes', 'lower back']::text[], 'barbell', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('B_Stance_Hip_Thrust', 'B-Stance Hip Thrust', array['glutes']::text[], array['hamstrings']::text[], 'barbell', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('Snatch_Grip_Deadlift', 'Snatch Grip Deadlift', array['hamstrings']::text[], array['glutes', 'lower back', 'traps', 'forearms']::text[], 'barbell', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('Paused_Deadlift', 'Paused Deadlift', array['hamstrings']::text[], array['glutes', 'lower back']::text[], 'barbell', 'compound', 'pull', 'powerlifting', 'intermediate', 'curated'),
('Single_Leg_Hip_Thrust', 'Single Leg Hip Thrust', array['glutes']::text[], array['hamstrings']::text[], 'body only', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Hip_Thrust_Machine', 'Hip Thrust Machine', array['glutes']::text[], array['hamstrings']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Glute_Kickback_Machine', 'Glute Kickback Machine', array['glutes']::text[], array['hamstrings']::text[], 'machine', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Multi_Hip_Machine', 'Multi-Hip Machine', array['glutes']::text[], array['abductors', 'adductors']::text[], 'machine', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Standing_Leg_Curl_Machine', 'Standing Leg Curl Machine', array['hamstrings']::text[], '{}'::text[], 'machine', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('Nordic_Hamstring_Curl', 'Nordic Hamstring Curl', array['hamstrings']::text[], array['glutes', 'calves']::text[], 'body only', 'isolation', 'pull', 'strength', 'expert', 'curated'),
('Reverse_Nordic', 'Reverse Nordic', array['quadriceps']::text[], array['abdominals']::text[], 'body only', 'isolation', 'push', 'strength', 'intermediate', 'curated'),
('Glute_Bridge_March', 'Glute Bridge March', array['glutes']::text[], array['hamstrings', 'abdominals']::text[], 'body only', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('45_Degree_Back_Extension', '45 Degree Back Extension', array['lower back']::text[], array['glutes', 'hamstrings']::text[], 'machine', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('GHD_Sit_Up', 'GHD Sit-Up', array['abdominals']::text[], array['quadriceps']::text[], 'machine', 'compound', 'pull', 'strength', 'intermediate', 'curated'),

-- Pressing: benches, machines, shoulders ----------------------------------
('Paused_Bench_Press', 'Paused Bench Press', array['chest']::text[], array['shoulders', 'triceps']::text[], 'barbell', 'compound', 'push', 'powerlifting', 'intermediate', 'curated'),
('Larsen_Press', 'Larsen Press', array['chest']::text[], array['shoulders', 'triceps']::text[], 'barbell', 'compound', 'push', 'powerlifting', 'intermediate', 'curated'),
('Z_Press', 'Z Press', array['shoulders']::text[], array['triceps', 'abdominals']::text[], 'barbell', 'compound', 'push', 'strength', 'intermediate', 'curated'),
('Pec_Deck', 'Pec Deck', array['chest']::text[], '{}'::text[], 'machine', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Incline_Chest_Press_Machine', 'Incline Chest Press Machine', array['chest']::text[], array['shoulders', 'triceps']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Iso_Lateral_Chest_Press', 'Iso-Lateral Chest Press (Hammer Strength)', array['chest']::text[], array['shoulders', 'triceps']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Iso_Lateral_Incline_Press', 'Iso-Lateral Incline Press (Hammer Strength)', array['chest']::text[], array['shoulders', 'triceps']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Iso_Lateral_Shoulder_Press', 'Iso-Lateral Shoulder Press (Hammer Strength)', array['shoulders']::text[], array['triceps']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Shoulder_Press_Machine', 'Shoulder Press Machine', array['shoulders']::text[], array['triceps']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Lateral_Raise_Machine', 'Lateral Raise Machine', array['shoulders']::text[], '{}'::text[], 'machine', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Rear_Delt_Fly_Machine', 'Rear Delt Fly Machine (Reverse Pec Deck)', array['shoulders']::text[], array['middle back']::text[], 'machine', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('Prone_Y_Raise', 'Prone Y Raise', array['shoulders']::text[], array['traps', 'middle back']::text[], 'dumbbell', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('Powell_Raise', 'Powell Raise', array['shoulders']::text[], array['middle back']::text[], 'dumbbell', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('Wall_Slide', 'Wall Slide', array['shoulders']::text[], array['traps']::text[], 'body only', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Scapular_Push_Up', 'Scapular Push-Up', array['shoulders']::text[], array['chest', 'triceps']::text[], 'body only', 'isolation', 'push', 'strength', 'beginner', 'curated'),

-- Rows and pulling machines -----------------------------------------------
('Pendlay_Row', 'Pendlay Row', array['middle back']::text[], array['lats', 'biceps', 'lower back']::text[], 'barbell', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('Seal_Row', 'Seal Row', array['middle back']::text[], array['lats', 'biceps']::text[], 'barbell', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('Meadows_Row', 'Meadows Row', array['lats']::text[], array['middle back', 'biceps']::text[], 'barbell', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('Kroc_Row', 'Kroc Row', array['lats']::text[], array['middle back', 'biceps', 'forearms']::text[], 'dumbbell', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('Chest_Supported_Row_Machine', 'Chest Supported Row Machine', array['middle back']::text[], array['lats', 'biceps']::text[], 'machine', 'compound', 'pull', 'strength', 'beginner', 'curated'),
('Iso_Lateral_Row', 'Iso-Lateral Row (Hammer Strength)', array['middle back']::text[], array['lats', 'biceps']::text[], 'machine', 'compound', 'pull', 'strength', 'beginner', 'curated'),
('Iso_Lateral_Lat_Pulldown', 'Iso-Lateral Lat Pulldown (Hammer Strength)', array['lats']::text[], array['middle back', 'biceps']::text[], 'machine', 'compound', 'pull', 'strength', 'beginner', 'curated'),
('High_Row_Machine', 'High Row Machine', array['lats']::text[], array['middle back', 'biceps']::text[], 'machine', 'compound', 'pull', 'strength', 'beginner', 'curated'),
('Low_Row_Machine', 'Low Row Machine', array['middle back']::text[], array['lats', 'biceps']::text[], 'machine', 'compound', 'pull', 'strength', 'beginner', 'curated'),
('Assisted_Pull_Up_Machine', 'Assisted Pull-Up Machine', array['lats']::text[], array['biceps', 'middle back']::text[], 'machine', 'compound', 'pull', 'strength', 'beginner', 'curated'),
('Assisted_Dip_Machine', 'Assisted Dip Machine', array['triceps']::text[], array['chest', 'shoulders']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Seated_Dip_Machine', 'Seated Dip Machine', array['triceps']::text[], array['chest']::text[], 'machine', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Triceps_Extension_Machine', 'Triceps Extension Machine', array['triceps']::text[], '{}'::text[], 'machine', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Bicep_Curl_Machine', 'Bicep Curl Machine', array['biceps']::text[], array['forearms']::text[], 'machine', 'isolation', 'pull', 'strength', 'beginner', 'curated'),

-- Core: anti-rotation, carries, ab machines -------------------------------
('Landmine_Rotation', 'Landmine Rotation', array['abdominals']::text[], array['shoulders']::text[], 'barbell', 'isolation', 'pull', 'strength', 'intermediate', 'curated'),
('Suitcase_Carry', 'Suitcase Carry', array['abdominals']::text[], array['forearms', 'traps']::text[], 'dumbbell', 'compound', 'static', 'strength', 'beginner', 'curated'),
('Overhead_Carry', 'Overhead Carry', array['shoulders']::text[], array['abdominals', 'traps']::text[], 'dumbbell', 'compound', 'static', 'strength', 'intermediate', 'curated'),
('Copenhagen_Plank', 'Copenhagen Plank', array['adductors']::text[], array['abdominals']::text[], 'body only', 'isolation', 'static', 'strength', 'intermediate', 'curated'),
('Hollow_Body_Hold', 'Hollow Body Hold', array['abdominals']::text[], '{}'::text[], 'body only', 'isolation', 'static', 'strength', 'intermediate', 'curated'),
('Bird_Dog', 'Bird Dog', array['lower back']::text[], array['glutes', 'abdominals']::text[], 'body only', 'isolation', 'static', 'strength', 'beginner', 'curated'),
('McGill_Curl_Up', 'McGill Curl-Up', array['abdominals']::text[], '{}'::text[], 'body only', 'isolation', 'static', 'strength', 'beginner', 'curated'),
('Torso_Rotation_Machine', 'Torso Rotation Machine', array['abdominals']::text[], '{}'::text[], 'machine', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('Captains_Chair_Leg_Raise', 'Captain''s Chair Leg Raise', array['abdominals']::text[], '{}'::text[], 'other', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('Roman_Chair_Sit_Up', 'Roman Chair Sit-Up', array['abdominals']::text[], array['quadriceps']::text[], 'other', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('Toes_To_Bar', 'Toes to Bar', array['abdominals']::text[], array['lats', 'forearms']::text[], 'body only', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('L_Sit_Hold', 'L-Sit Hold', array['abdominals']::text[], array['quadriceps', 'triceps']::text[], 'body only', 'isolation', 'static', 'strength', 'expert', 'curated'),

-- Calves, ankles, feet (runner staples) -----------------------------------
('Tibialis_Raise', 'Tibialis Raise', array['calves']::text[], '{}'::text[], 'body only', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('Tib_Bar_Raise', 'Tib Bar Raise', array['calves']::text[], '{}'::text[], 'other', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('Single_Leg_Calf_Raise', 'Single Leg Calf Raise', array['calves']::text[], '{}'::text[], 'body only', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Bent_Knee_Calf_Raise', 'Bent Knee Calf Raise (Soleus)', array['calves']::text[], '{}'::text[], 'machine', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Leg_Press_Calf_Raise', 'Leg Press Calf Raise', array['calves']::text[], '{}'::text[], 'machine', 'isolation', 'push', 'strength', 'beginner', 'curated'),

-- Hips and lateral chain (runner staples) ---------------------------------
('Psoas_March', 'Psoas March', array['quadriceps']::text[], array['abdominals']::text[], 'bands', 'isolation', 'pull', 'strength', 'beginner', 'curated'),
('Clamshell', 'Clamshell', array['abductors']::text[], array['glutes']::text[], 'bands', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Fire_Hydrant', 'Fire Hydrant', array['glutes']::text[], array['abductors']::text[], 'body only', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Lateral_Band_Walk', 'Lateral Band Walk', array['abductors']::text[], array['glutes']::text[], 'bands', 'isolation', 'push', 'strength', 'beginner', 'curated'),
('Hip_Airplane', 'Hip Airplane', array['glutes']::text[], array['abductors', 'lower back']::text[], 'body only', 'isolation', 'static', 'strength', 'intermediate', 'curated'),
('Couch_Stretch', 'Couch Stretch', array['quadriceps']::text[], array['glutes']::text[], 'body only', null, 'static', 'stretching', 'beginner', 'curated'),
('Jefferson_Curl', 'Jefferson Curl', array['hamstrings']::text[], array['lower back']::text[], 'dumbbell', 'isolation', 'pull', 'stretching', 'intermediate', 'curated'),

-- Climbing: grip, hangs, scapular strength --------------------------------
('Dead_Hang', 'Dead Hang', array['forearms']::text[], array['lats', 'shoulders']::text[], 'body only', 'isolation', 'static', 'strength', 'beginner', 'curated'),
('Weighted_Dead_Hang', 'Weighted Dead Hang', array['forearms']::text[], array['lats', 'shoulders']::text[], 'other', 'isolation', 'static', 'strength', 'intermediate', 'curated'),
('Hangboard_Half_Crimp_Hang', 'Hangboard Half Crimp Hang', array['forearms']::text[], array['lats', 'shoulders']::text[], 'other', 'isolation', 'static', 'strength', 'intermediate', 'curated'),
('Hangboard_Open_Hand_Hang', 'Hangboard Open Hand Hang', array['forearms']::text[], array['lats', 'shoulders']::text[], 'other', 'isolation', 'static', 'strength', 'intermediate', 'curated'),
('Front_Lever_Tuck_Hold', 'Front Lever Tuck Hold', array['lats']::text[], array['abdominals', 'middle back']::text[], 'body only', 'isolation', 'static', 'strength', 'expert', 'curated'),
('Towel_Pull_Up', 'Towel Pull-Up', array['forearms']::text[], array['lats', 'biceps']::text[], 'body only', 'compound', 'pull', 'strength', 'intermediate', 'curated'),
('Pinch_Block_Hold', 'Pinch Block Hold', array['forearms']::text[], '{}'::text[], 'other', 'isolation', 'static', 'strength', 'intermediate', 'curated'),

-- Conditioning and power ----------------------------------------------------
('Assault_Bike', 'Assault Bike', array['quadriceps']::text[], array['hamstrings', 'shoulders']::text[], 'machine', 'compound', 'push', 'cardio', 'beginner', 'curated'),
('Ski_Erg', 'Ski Erg', array['lats']::text[], array['triceps', 'abdominals']::text[], 'machine', 'compound', 'pull', 'cardio', 'beginner', 'curated'),
('Incline_Treadmill_Walk', 'Incline Treadmill Walk', array['quadriceps']::text[], array['calves', 'glutes']::text[], 'machine', 'compound', 'push', 'cardio', 'beginner', 'curated'),
('Battle_Ropes', 'Battle Ropes', array['shoulders']::text[], array['abdominals', 'forearms']::text[], 'other', 'compound', 'pull', 'cardio', 'beginner', 'curated'),
('Wall_Ball', 'Wall Ball', array['quadriceps']::text[], array['shoulders', 'glutes']::text[], 'medicine ball', 'compound', 'push', 'strength', 'beginner', 'curated'),
('Med_Ball_Slam', 'Med Ball Slam', array['abdominals']::text[], array['lats', 'shoulders']::text[], 'medicine ball', 'compound', 'pull', 'strength', 'beginner', 'curated'),
('Jump_Rope', 'Jump Rope', array['calves']::text[], array['quadriceps', 'shoulders']::text[], 'other', 'compound', 'push', 'cardio', 'beginner', 'curated'),
('Pogo_Jumps', 'Pogo Jumps', array['calves']::text[], array['quadriceps']::text[], 'body only', 'compound', 'push', 'plyometrics', 'beginner', 'curated'),
('Broad_Jump', 'Broad Jump', array['quadriceps']::text[], array['glutes', 'hamstrings', 'calves']::text[], 'body only', 'compound', 'push', 'plyometrics', 'intermediate', 'curated'),
('A_Skip', 'A-Skip', array['quadriceps']::text[], array['calves', 'hamstrings']::text[], 'body only', 'compound', 'push', 'plyometrics', 'beginner', 'curated')
on conflict (id) do update set
  name = excluded.name,
  primary_muscles = excluded.primary_muscles,
  secondary_muscles = excluded.secondary_muscles,
  equipment = excluded.equipment,
  mechanic = excluded.mechanic,
  force = excluded.force,
  category = excluded.category,
  level = excluded.level
where exercises.source = 'curated';
