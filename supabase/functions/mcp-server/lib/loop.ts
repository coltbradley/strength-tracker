// The loop's pure logic: recognising a day, carrying what was learned forward.
//
// `find_similar_days` and `repeat_planned_workout` share these. Nothing here
// touches the database, so all of it is tested without one (loop.test.ts).
//
// Three rules live here and each one guards structure the plan encodes as
// ADJACENCY (CLAUDE.md): consecutive same-exercise rows are a ramp, consecutive
// same-section rows are a titled block, and the unit of any reordering is the
// entry, never the row. A repeat that reorders rows one at a time would tear a
// ramp in half, which is a bug class this repo has already had.

/** How alike two exercise sets must be for a day to count as "the same day".
 *  0.6 lets a nine-exercise day match with two swapped out, or one added, and
 *  stops a day that merely shares squats and rows from claiming kinship. */
export const SIMILARITY_THRESHOLD = 0.6;

/** |A ∩ B| / |A ∪ B| over exercise ids. Two empty sets are 0, not NaN: an
 *  empty day is a draft and matches nothing. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Does a set note read as an INSTRUCTION to whoever prescribes the next one,
 * rather than a fact about the set?
 *
 * "Could be more, maybe 70?" is not a record of what happened; it is a message
 * to next time, and until this existed nobody read it before next time was
 * written. "Grey band too light, moved up" is the same. "Felt heavy" and
 * "sleep wasn't great" are facts, and copying those forward would put stale
 * complaints on a fresh day.
 *
 * A heuristic, deliberately loose: the cost of a false positive is one extra
 * line for the coach to glance at and dismiss; the cost of a false negative is
 * the note staying trapped where it was. Matches:
 *  - forward-looking words ("next time", "maybe", "try", "should", "could")
 *  - direction words about load or band ("go up", "heavier", "lighter",
 *    "too light", "too heavy", "move up", "bump", "drop")
 *  - a trailing question mark, which is how people write a suggestion they
 *    are not sure of
 */
export function readsAsInstruction(note: string): boolean {
  const t = note.trim();
  if (t === "") return false;
  if (/\?\s*$/.test(t)) return true;
  return INSTRUCTION_RE.test(t);
}

const INSTRUCTION_RE = new RegExp(
  [
    "\\bnext (time|session|week)\\b",
    "\\bmaybe\\b",
    "\\btry\\b",
    "\\bshould\\b",
    "\\bcould (be|do|go|use|have)\\b",
    "\\bgo (up|down|heavier|lighter)\\b",
    "\\bmove (up|down)\\b",
    "\\b(bump|drop|raise|lower|increase|decrease) (it|this|the|to|by)\\b",
    "\\btoo (light|heavy|easy|hard|much|little)\\b",
    "\\b(heavier|lighter|stronger|thicker|thinner) (band|next|one)\\b",
    "\\buse (a |the )?(strong|heavy|light|thick|thin|\\w+ band)\\b",
    "\\b(add|more) (weight|load|reps|sets)\\b",
    "\\bup to \\d",
  ].join("|"),
  "i",
);

/** The shape both tools read back from `prescriptions`. Nullable columns are
 *  null here, exactly as PostgREST returns them. */
export interface RxRow {
  exercise_id: string;
  position: number;
  sets: number;
  reps_min: number;
  reps_max: number;
  load_kg: number | null;
  load_pct_tm: number | null;
  load_entry: "total" | "per_side" | null;
  rest_seconds: number | null;
  notes: string | null;
  superset_group: number | null;
  section: string | null;
  set_type: "warmup" | "working" | "backoff";
  tracking: "reps" | "done";
}

/** A logged set as `v_live_sets` returns it, with the note joined on. */
export interface LoggedSet {
  exercise_id: string;
  set_index: number;
  set_type: string;
  load_kg: number;
  load_entry: string | null;
  reps: number;
  performed_at: string;
  note?: string;
}

/** Prescription loads are held to the half-kilo; anything finer is invented. */
function halfKilo(kg: number): number {
  return Math.round(kg * 2) / 2;
}

/**
 * New loads for a day's rows given what was lifted last time. `null` means
 * "leave this row exactly as it is". A port of the app's saved-workout rule
 * (`pwa/src/lib/templateLoads.ts` `refreshedLoads`), which this must keep
 * agreeing with: the two are the same feature from two doors, and a lifter
 * who applies a template in the app and asks the coach to repeat a day should
 * get the same numbers.
 *
 * The unit of refresh is the RAMP, not the row. Overwriting every row with
 * the last actual turns 60 / 85 / 112.5 into 110 / 110 / 110 and destroys the
 * warmup build-up; instead the ramp is rescaled so its top set lands exactly
 * on what was lifted and the rest keep their shape relative to it.
 *
 * Left alone: %TM rows (they follow a training max that moves on its own),
 * rows with no load (bodyweight, by feel, a tick), and every row of a ramp
 * whose exercise was not logged last time.
 */
export function refreshedLoads(
  rows: RxRow[],
  lastLoads: Map<string, number>,
): (number | null)[] {
  const out: (number | null)[] = new Array(rows.length).fill(null);
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].exercise_id === rows[i].exercise_id) {
      j += 1;
    }
    const group = rows.slice(i, j + 1);
    const last = lastLoads.get(rows[i].exercise_id);
    const scalable = group.filter(
      (r) => r.load_pct_tm === null && r.load_kg !== null && r.load_kg > 0,
    );
    const top = Math.max(...scalable.map((r) => r.load_kg ?? 0), 0);
    if (last !== undefined && last > 0 && top > 0) {
      const factor = last / top;
      for (let k = i; k <= j; k++) {
        const r = rows[k];
        if (r.load_pct_tm !== null || r.load_kg === null || r.load_kg <= 0) {
          continue;
        }
        out[k] = r.load_kg === top ? last : halfKilo(r.load_kg * factor);
      }
    }
    i = j + 1;
  }
  return out;
}

/**
 * The load the app would call "last time" for each exercise: the LATEST
 * working set's load, which is the same pick `scanLastActuals` makes in the
 * PWA (newest row first, working type only). Not the heaviest — a lifter who
 * backed off after a miss meant the back-off.
 */
export function lastWorkingLoads(sets: LoggedSet[]): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Map<string, string>();
  for (const s of sets) {
    if (s.set_type !== "working") continue;
    const prev = seen.get(s.exercise_id);
    if (prev === undefined || s.performed_at > prev) {
      seen.set(s.exercise_id, s.performed_at);
      out.set(s.exercise_id, s.load_kg);
    }
  }
  return out;
}

/** exercise_id -> when it was FIRST touched, which is what "the order they
 *  actually did it in" means for a session. */
export function firstPerformedAt(sets: LoggedSet[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sets) {
    const prev = out.get(s.exercise_id);
    if (prev === undefined || s.performed_at < prev) {
      out.set(s.exercise_id, s.performed_at);
    }
  }
  return out;
}

/** Exercise ids in the order they were first performed. */
export function performedOrder(sets: LoggedSet[]): string[] {
  return [...firstPerformedAt(sets).entries()]
    .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id]) => id);
}

/** A run of consecutive rows naming one exercise: the unit of reordering. */
interface Entry {
  rows: RxRow[];
  exercise_id: string;
}

/** A run of entries that must stay contiguous: every entry of a named section
 *  in one block, each unsectioned entry as its own block (CLAUDE.md: main work
 *  is a label on a run, never a block, and each unsectioned exercise IS its
 *  own block). */
interface Block {
  entries: Entry[];
  section: string | null;
}

function entriesOf(rows: RxRow[]): Entry[] {
  const out: Entry[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last !== undefined && last.exercise_id === r.exercise_id) {
      last.rows.push(r);
    } else out.push({ rows: [r], exercise_id: r.exercise_id });
  }
  return out;
}

function blocksOf(entries: Entry[]): Block[] {
  const out: Block[] = [];
  for (const e of entries) {
    const section = e.rows[0].section;
    const last = out[out.length - 1];
    if (section !== null && last !== undefined && last.section === section) {
      last.entries.push(e);
    } else out.push({ entries: [e], section });
  }
  return out;
}

/**
 * Reorder `items` so that the ones with a key come out sorted by key, while
 * the ones WITHOUT a key keep the exact slots they had. A skipped activation
 * in the middle of a day stays in the middle of the day; only what was
 * actually done gets put in the order it was done in.
 */
function fillSlots<T>(items: T[], keyOf: (t: T) => string | undefined): T[] {
  const performed = items
    .map((t, i) => ({ t, i, key: keyOf(t) }))
    .filter((x): x is { t: T; i: number; key: string } => x.key !== undefined)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i));
  let next = 0;
  return items.map((t) =>
    keyOf(t) === undefined ? t : performed[next++].t
  );
}

/**
 * The day's rows in the order the exercises were actually performed last
 * time, with the plan's structure intact.
 *
 * Ramps move as one. Named sections move as one block, ordered by the first
 * thing done inside them, and are reordered inside themselves by the same
 * rule. Unsectioned entries move freely. Anything not performed keeps its
 * slot. Rows come back with `position` renumbered from 0 — the array order is
 * the order, exactly as `prescriptionRows` reads it.
 */
export function reorderByPerformed(
  rows: RxRow[],
  first: Map<string, string>,
): { rows: RxRow[]; changed: boolean } {
  const entryKey = (e: Entry) => first.get(e.exercise_id);
  const blockKey = (b: Block): string | undefined => {
    const keys = b.entries.map(entryKey).filter((k): k is string =>
      k !== undefined
    );
    return keys.length === 0 ? undefined : keys.sort()[0];
  };
  const blocks = fillSlots(blocksOf(entriesOf(rows)), blockKey).map((b) => ({
    ...b,
    entries: fillSlots(b.entries, entryKey),
  }));
  const out = blocks.flatMap((b) => b.entries.flatMap((e) => e.rows));
  const changed = out.some((r, i) => r !== rows[i]);
  return {
    rows: out.map((r, i) => ({ ...r, position: i })),
    changed,
  };
}

/** Exercise ids in plan order, one per entry (a ramp counts once). */
export function entryOrder(rows: RxRow[]): string[] {
  return entriesOf(rows).map((e) => e.exercise_id);
}

/**
 * Did the lifter do the exercises in a different order from the plan? Only
 * exercises present in BOTH lists count: an extra they added, or a planned
 * movement they skipped, is not a reordering.
 */
export function orderDiffers(planned: string[], performed: string[]): boolean {
  const p = new Set(planned);
  const q = new Set(performed);
  const a = [...new Set(planned)].filter((id) => q.has(id));
  const b = performed.filter((id) => p.has(id));
  return a.some((id, i) => b[i] !== id);
}
