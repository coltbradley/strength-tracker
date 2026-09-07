// Per-set RPE — how hard the set felt. RPE is the number a coach
// autoregulates on: "8 reps at RPE 9" and "8 reps at RPE 6" are the same row
// in `sets` and opposite instructions in practice.
//
// Null is the ordinary state, not a gap. Rating is one optional tap, `sets` is
// append-only, and an unrated set can only ever be rated by voiding and
// relogging — so nothing derived from a set may require this, and no copy may
// read as if the lifter forgot something.
//
// This module is the ONE place the scale is written down. The bounds are the
// column's bounds (supabase/migrations/20260906010000_set_rpe.sql) and the
// scale is derived from them rather than typed out, so the app cannot offer a
// value Postgres refuses and cannot drift from it later.

/** The column's floor. Below 5 is noise: nobody distinguishes a 3 from a 4. */
export const RPE_MIN = 5;
export const RPE_MAX = 10;
/** Half points only. Coaches say 7.5, never 7.3, and a finer value would be a
 *  fake precision no view could interpret. */
export const RPE_STEP = 0.5;

/** Every value the column accepts, ascending. 0.5 is exact in binary, so these
 *  are the same numbers the CHECK constraint reads. */
export const RPE_SCALE: readonly number[] = Array.from(
  { length: Math.round((RPE_MAX - RPE_MIN) / RPE_STEP) + 1 },
  (_, i) => RPE_MIN + i * RPE_STEP,
);

/**
 * The lowest value the CHIPS offer, deliberately above `RPE_MIN`.
 *
 * Not a second source of truth: `RPE_SCALE` stays the authority on what is
 * LEGAL, and this is only what is worth a tap. Eleven chips on a phone makes
 * every one of them smaller, and the bottom four are dead weight — a set at
 * RPE 5 was a warmup, which the set type already says. A 5 that reaches the
 * column from anywhere else is still valid and still renders.
 */
export const RPE_FLOOR_OFFERED = 6.5;

/** What the chip row shows. */
export const RPE_CHOICES: readonly number[] = RPE_SCALE.filter(
  (v) => v >= RPE_FLOOR_OFFERED,
);

// ---- session RPE ----------------------------------------------------------
//
// How hard the WHOLE workout was, which is a different question from how hard
// one set was and has a different column: `sessions.session_rpe`, a smallint
// checked `between 0 and 10`. Whole points, and the floor really is 0, because
// a session at 0 is a rest day someone opened the app on — where a SET at 0
// is not a set. Written here for the same reason the set scale is: the app
// must not offer a value Postgres refuses.
//
// Captured on the End screen, and from Today for a day afterwards, because End
// is only reached by tapping Finish and the sessions that go unrated are
// exactly the ones that were hardest to finish.

export const SESSION_RPE_MIN = 0;
export const SESSION_RPE_MAX = 10;

/** Every value `sessions.session_rpe` accepts, ascending. */
export const SESSION_RPE_CHOICES: readonly number[] = Array.from(
  { length: SESSION_RPE_MAX - SESSION_RPE_MIN + 1 },
  (_, i) => SESSION_RPE_MIN + i,
);
