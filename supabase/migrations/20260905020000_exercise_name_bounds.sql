-- An exercise name is text one person writes and another person's model reads.
--
-- The library is SHARED. update_exercise can rename a seeded row (it re-tags
-- it 'edited' so no re-seed reverts it, 20260901010000), and that name then
-- travels: search_exercises returns it, get_program returns it through
-- v_resolved_prescriptions.exercise_name, and the coach's per-turn context
-- block puts it in front of the model unquoted, for EVERY account on the
-- deployment — not only the one that typed it. `exercises.name` was `text`
-- with no constraint at all, so the one field a user can write and every
-- user's coach must read had no bound on its length and no bound on what
-- could be in it.
--
-- That is a cross-user prompt-injection surface, and the dangerous part is
-- structural rather than semantic: a name carrying newlines can close whatever
-- framing it was rendered inside and open another one, and a name carrying
-- zero-width or bidi formatting characters can do it invisibly, so the person
-- reading "Barbell Squat" in the picker and the model reading the row disagree
-- about what the row says. One line of bounded plain text can still say
-- something rude; it cannot forge a turn.
--
-- So: bound the length, and require a single line of printable text. The
-- seeded library is the calibration — 979 rows across both seeds, longest 58
-- characters, and the punctuation they actually use is apostrophes, parens,
-- commas, hyphens and slashes ("Farmer's Walk", "Belt Squat (Machine)",
-- "3/4 Sit-Up", "Adductor/Groin"). 80 leaves real headroom for a custom name
-- without leaving room for a paragraph.
--
-- Deliberately NOT an allow-list of characters. Whitelisting ASCII letters
-- would refuse a name written in a script this repo's author does not read,
-- and the POSIX classes that would not ([[:alpha:]], [[:print:]]) are
-- collation-dependent, which means a constraint accepting different text in
-- PGlite than in Postgres than in production. Naming what is dangerous is both
-- narrower and portable: the C0/C1 control characters, the Unicode line and
-- paragraph separators, and the invisible formatting characters.
alter table exercises
  add constraint exercises_name_plain check (
    -- Non-empty after trimming, so a name can be neither blank nor whitespace,
    -- and short enough that it cannot carry a paragraph of instructions.
    char_length(btrim(name)) between 1 and 80
    -- One line, printable: C0 controls (newline, tab, escape) and C1.
    and name !~ '[\u0001-\u001f\u007f-\u009f]'
    -- Newlines that are not control characters.
    and name !~ '[\u2028\u2029]'
    -- Invisible by design: soft hyphen, zero-width space and joiners, the
    -- LTR/RTL marks and the embedding/override controls, word joiner and the
    -- invisible maths operators, the deprecated interlinear annotation marks,
    -- and the byte-order mark. Text nobody can see is text nobody can review.
    and name !~ '[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]'
  );

comment on column exercises.name is
  'Display name. Bounded to 80 characters of single-line printable text '
  'because this is a SHARED library: a rename by one account reaches every '
  'other account''s model context through search_exercises, get_program and '
  'the coach context block, so it is untrusted cross-user input rather than '
  'a label.';

-- Who changed it, and when.
--
-- The name is bounded now but still mutable, and the question that was
-- impossible to answer after the fact was "this library row no longer says
-- what the seed says — who did that?". source='edited' records THAT a human
-- changed a seeded row; it cannot say which human, or when, so a rename that
-- landed in everyone's context had no trail back to an account at all.
--
-- CLAUDE.md forbids `exercises` growing a per-user column, for two stated
-- reasons: 873 generated rows would carry a null forever, and every re-seed
-- would write it back. Neither applies to an audit stamp, and the distinction
-- is worth stating because the rule is otherwise absolute:
--
--   * Null here is not a placeholder standing in for a value that belongs in
--     the row. It IS the answer — "not modified since it was seeded" — true of
--     the whole library the day this lands and true of most of it forever.
--   * The seeds do not touch these columns. Both ON CONFLICT DO UPDATE clauses
--     name eight columns and neither of these is one, so no re-seed writes
--     them back.
--   * It is not ownership and must never be read as ownership. Ownership lives
--     in exercise_owners and nowhere else; no policy, view or MCP guard may
--     branch on updated_by. It answers "who touched this", not "whose is
--     this" — the distinction the `source` column failed to make, which is the
--     bug 20260901010000 exists to repair.
--
-- This is a deviation from a hard rule and belongs in docs/decisions.md.
alter table exercises add column updated_at timestamptz;
alter table exercises add column updated_by uuid
  references auth.users (id) on delete set null;

comment on column exercises.updated_at is
  'When this row was last changed by an edit (never by a seed). Null means '
  'unmodified since seeding, which is true of the entire seeded library.';

comment on column exercises.updated_by is
  'Which account made that edit, where one is known: null on the MCP path '
  'unless the tool stamps it, because the service role has no auth.uid(). An '
  'audit trail ONLY — ownership is exercise_owners, and nothing may branch on '
  'this column.';

-- Stamped by a trigger rather than by each writer, for the reason
-- claim_custom_exercise is a trigger: there are two write paths (the PWA under
-- RLS, the MCP server under the service role), and a stamp every future call
-- site has to remember is one a future call site will forget.
--
-- Two details carry weight. The no-op guard means a re-seed rewriting a row
-- with the values it already holds does not claim somebody edited it — the
-- seeds upsert every row on every run. And an explicitly supplied updated_by
-- wins over auth.uid(), so the MCP server can name the token's user on a path
-- where auth.uid() is null; left alone there it stays null, which is honest
-- rather than wrong.
create or replace function stamp_exercise_edit() returns trigger
  language plpgsql
  as $$
  begin
    if new is not distinct from old then
      return new;
    end if;
    new.updated_at := now();
    if new.updated_by is not distinct from old.updated_by then
      new.updated_by := auth.uid();
    end if;
    return new;
  end
  $$;

create trigger exercises_stamp_edit
  before update on exercises
  for each row execute function stamp_exercise_edit();
