-- Demo photos and how-to steps, from the place the library already came from.
--
-- free-exercise-db ships two photos per exercise (start and end position) and
-- numbered instructions, for every one of its 873 movements, under the same
-- Unlicense — and scripts/build-exercise-seed.mjs has thrown both away since
-- the first seed. A lifter meeting a movement the coach invented for them had
-- a name and nothing else.
--
-- Two columns, both passing the rule on `exercises` columns (CLAUDE.md):
-- neither varies per viewer, and the generated seed populates all 873, so
-- nothing sits null forever and no re-seed writes anything back. '{}' is
-- "none" — the idiom the muscle arrays already use — and is what a custom or
-- curated row gets.
--
-- `images` holds PATHS relative to the upstream repo, never URLs. The host is
-- ONE constant in the PWA (lib/exerciseMedia.ts), so moving to a mirror is one
-- edit and no row can carry a different origin. The CHECK pins the shape at
-- the database, because the library is SHARED: an 'edited' row is read by
-- every account, and an image URL a person could type into a shared row is a
-- tracking pixel in every other account's session screen. Seed-only, by
-- construction rather than by convention.
alter table exercises
  add column images text[] not null default '{}',
  add column instructions text[] not null default '{}',
  add constraint exercises_images_are_paths check (
    images = '{}'
    or array_to_string(images, ',') ~ '^([0-9A-Za-z_-]+/[0-9]+\.jpg)(,[0-9A-Za-z_-]+/[0-9]+\.jpg)*$'
  );

comment on column exercises.images is
  'Demo photo PATHS under free-exercise-db/exercises/ (e.g. Barbell_Squat/0.jpg), start then end position. Seed-only; the PWA supplies the host.';
comment on column exercises.instructions is
  'Numbered how-to steps from the seed, in order. Seed-only.';
