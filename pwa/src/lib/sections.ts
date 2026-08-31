// The SHAPE of a planned day: which rows are one exercise, which exercises
// are one part of the session, and what order the parts run in.
//
// `prescriptions` is a flat list ordered by `position`. Two things a row
// cannot say on its own, and the plan editor got both wrong by reading rows
// directly:
//
//  - The unit a person edits is not a row. Consecutive rows naming the same
//    exercise are one ramp; rows sharing a `superset_group` are one superset.
//    Sectioning or dragging a single row tore both apart — worse for a
//    superset, where the pairing IS the prescription, so a superset split
//    across a heading describes a day nobody can perform.
//  - A name appears once. Heading a row whenever the row above it differed
//    printed "SUPERSET A" twice for a group whose members had drifted apart,
//    which reads as two supersets that happen to share a letter.
//
// So the editor never renders rows. It renders BLOCKS of ENTRIES, built here:
// a name cannot be rendered twice because it exists once in the structure,
// and a drag cannot split anything because a block and an entry are the only
// things the structure contains.
//
// Pure functions of plain rows — no React, no network — because every rule
// here decides what gets written to `position` and `section`.

import type { ResolvedPrescriptionRow } from "./types";

/** One exercise as the editor lists it: a ramp, or a whole superset. */
export interface PlanEntry {
  /** the first row's id; stable while the entry keeps its first row */
  key: string;
  /** the rows it owns, in list order */
  rows: ResolvedPrescriptionRow[];
  /** trimmed section name; null = the main body, which needs no heading */
  section: string | null;
  /** 1=A … 4=D, or null when this is a plain ramp */
  supersetGroup: number | null;
  /** distinct exercises in it — more than one only inside a superset */
  exercises: number;
}

/** One part of the day: a named section, or a single unsectioned exercise. */
export interface PlanBlock {
  /** `sec:<name>` or `entry:<key>` — a section exists once, so its key does */
  key: string;
  section: string | null;
  entries: PlanEntry[];
}

/** "" and "   " are the main body, same as null. */
export function normalizeSection(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

/**
 * Where a named part of the day runs, relative to the main body.
 *
 * One table, matched in order, and everything it does not recognise ranks
 * with the main body — so a section the coach invented ("Grip", "Carries")
 * keeps the place the user put it instead of being banished to one end.
 * Ranks are the only thing that outranks the stored order; within a rank the
 * day runs in the order it is written.
 */
const SECTION_ORDER: { rank: number; match: RegExp }[] = [
  { rank: -1, match: /\b(activation|warm[- ]?up|prep|primer|mobility)/i },
  { rank: 1, match: /\b(cool[- ]?down|stretch|finisher)/i },
];

/** −1 before the main body, 0 with it, 1 after it. */
export function sectionRank(section: string | null): number {
  if (section === null) return 0;
  return SECTION_ORDER.find((s) => s.match.test(section))?.rank ?? 0;
}

/**
 * Collapse rows into the entries a person edits.
 *
 * A superset is gathered by GROUP, not by adjacency: the letter is the
 * coach's declaration that these exercises alternate, so members that have
 * drifted apart are one entry that the editor then writes back together.
 * `groupRamps` (entries.ts) stays adjacency-only for the session screens,
 * which cannot reorder anything and must render what is stored.
 *
 * A ramp is adjacency-only, exactly as `groupRamps` has it: squat early and
 * squat as a finisher are two exercises in the day, not one interrupted one.
 */
export function planEntries(rows: ResolvedPrescriptionRow[]): PlanEntry[] {
  const order: string[] = [];
  const byUnit = new Map<string, ResolvedPrescriptionRow[]>();
  let ramp = 0;
  let prev: ResolvedPrescriptionRow | undefined;
  for (const r of rows) {
    const group = r.superset_group ?? null;
    if (
      group === null &&
      (prev === undefined ||
        (prev.superset_group ?? null) !== null ||
        prev.exercise_id !== r.exercise_id)
    )
      ramp += 1;
    const unit = group === null ? `ramp:${ramp}` : `ss:${group}`;
    const held = byUnit.get(unit);
    if (held === undefined) {
      byUnit.set(unit, [r]);
      order.push(unit);
    } else held.push(r);
    prev = r;
  }
  return order.map((unit) => {
    const held = byUnit.get(unit)!;
    return {
      key: held[0]!.id,
      rows: held,
      // The first row's name wins. Every write path here puts a whole entry
      // in one section, so they only ever disagree on rows written before
      // that was true.
      section: normalizeSection(held[0]!.section),
      supersetGroup: held[0]!.superset_group ?? null,
      exercises: new Set(held.map((r) => r.exercise_id)).size,
    };
  });
}

/**
 * The day as parts, ranked.
 *
 * A named section is ONE block holding every entry that names it, placed
 * where the section first appears. An unsectioned exercise is a block of its
 * own, so it keeps its own place in the list rather than being swept into a
 * single "main" lump that a mid-list section would have to jump over.
 */
export function planBlocks(rows: ResolvedPrescriptionRow[]): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  const byName = new Map<string, PlanBlock>();
  for (const entry of planEntries(rows)) {
    if (entry.section === null) {
      blocks.push({
        key: `entry:${entry.key}`,
        section: null,
        entries: [entry],
      });
      continue;
    }
    const held = byName.get(entry.section);
    if (held !== undefined) {
      held.entries.push(entry);
      continue;
    }
    const block: PlanBlock = {
      key: `sec:${entry.section}`,
      section: entry.section,
      entries: [entry],
    };
    byName.set(entry.section, block);
    blocks.push(block);
  }
  // Stable: rank decides, and ties keep the order the day is written in.
  return blocks
    .map((b, i) => ({ b, i }))
    .sort(
      (x, y) =>
        sectionRank(x.b.section) - sectionRank(y.b.section) || x.i - y.i,
    )
    .map((x) => x.b);
}

/** Every row in the blocks, in the order they render. */
export function blockRowIds(blocks: PlanBlock[]): string[] {
  return blocks.flatMap((b) =>
    b.entries.flatMap((e) => e.rows.map((r) => r.id)),
  );
}

/**
 * The row order the day SHOULD be stored in.
 *
 * Called after any write that changes grouping — a section, a superset
 * letter, an added exercise — so what the editor renders is also what
 * Today and the session screen read. Rendering a healed order without
 * storing it would leave the two screens describing different days.
 */
export function canonicalRowIds(rows: ResolvedPrescriptionRow[]): string[] {
  return blockRowIds(planBlocks(rows));
}

/** The entry that owns a row, or null. */
export function entryOf(
  rows: ResolvedPrescriptionRow[],
  rowId: string,
): PlanEntry | null {
  return (
    planEntries(rows).find((e) => e.rows.some((r) => r.id === rowId)) ?? null
  );
}

/**
 * Every row a section assignment on `rowId` has to carry with it.
 *
 * A section holds whole exercises: putting one bracket of a ramp under
 * "ACTIVATIONS" and leaving the other two outside it is not a thing a day
 * can mean.
 */
export function sectionUnit(
  rows: ResolvedPrescriptionRow[],
  rowId: string,
): ResolvedPrescriptionRow[] {
  return entryOf(rows, rowId)?.rows ?? [];
}

/** The blocks named by `keys`, in that order; anything missing is dropped. */
export function reorderBlocks(
  blocks: PlanBlock[],
  keys: string[],
): PlanBlock[] {
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  return keys
    .map((k) => byKey.get(k))
    .filter((b): b is PlanBlock => b !== undefined);
}

/** The entries of `blocks` in list order — the drag list one level down. */
export function entryKeys(blocks: PlanBlock[]): string[] {
  return blocks.flatMap((b) => b.entries.map((e) => e.key));
}

/**
 * Apply a dragged entry order, block by block.
 *
 * Entries are confined to their own block (`entryBand`), so this only ever
 * shuffles within one; sorting per block rather than rebuilding from the flat
 * list means a key that somehow escaped its block cannot take its rows with it.
 */
export function reorderEntries(
  blocks: PlanBlock[],
  keys: string[],
): PlanBlock[] {
  const rank = new Map(keys.map((k, i) => [k, i]));
  return blocks.map((b) => ({
    ...b,
    entries: [...b.entries].sort(
      (x, y) => (rank.get(x.key) ?? 0) - (rank.get(y.key) ?? 0),
    ),
  }));
}

/**
 * The index range an entry may be dragged within: its own block.
 *
 * An exercise leaves a section by being given a different one, never by being
 * dragged out of it — the section control says where it goes, and a section
 * that can be half-escaped by a stray finger is not a part of the day.
 */
export function entryBand(
  blocks: PlanBlock[],
  key: string,
): [number, number] | null {
  let start = 0;
  for (const b of blocks) {
    if (b.entries.some((e) => e.key === key))
      return [start, start + b.entries.length - 1];
    start += b.entries.length;
  }
  return null;
}

/**
 * The index range a block may be dragged within: the run of blocks sharing
 * its rank.
 *
 * Cooldown cannot be dragged above the main body because it would not stay
 * there — `planBlocks` ranks it back down on the next render. A drag that
 * silently undoes itself is worse than one that will not go.
 */
export function blockBand(
  blocks: PlanBlock[],
  key: string,
): [number, number] | null {
  const i = blocks.findIndex((b) => b.key === key);
  if (i < 0) return null;
  const rank = sectionRank(blocks[i]!.section);
  let lo = i;
  while (lo > 0 && sectionRank(blocks[lo - 1]!.section) === rank) lo--;
  let hi = i;
  while (
    hi + 1 < blocks.length &&
    sectionRank(blocks[hi + 1]!.section) === rank
  )
    hi++;
  return [lo, hi];
}

/**
 * Move a whole part one step, within its rank band.
 *
 * The heading is already a drag handle, but a control you have to press and
 * hold to discover is one most people never find — and a drag with no
 * alternative fails WCAG 2.5.7, which the exercise rows got right with ↑/↓ and
 * sections did not. Same band as the drag (`blockBand`), so the buttons can
 * never put a part somewhere the next render would rank it straight back out
 * of.
 *
 * Returns null when there is nowhere to go, which is also what disables the
 * button.
 */
export function moveBlock(
  blocks: PlanBlock[],
  key: string,
  dir: -1 | 1,
): PlanBlock[] | null {
  const i = blocks.findIndex((b) => b.key === key);
  if (i < 0) return null;
  const band = blockBand(blocks, key);
  if (band === null) return null;
  const j = i + dir;
  if (j < band[0] || j > band[1]) return null;
  const next = [...blocks];
  const a = next[i]!;
  next[i] = next[j]!;
  next[j] = a;
  return next;
}

/**
 * Move one exercise a step, without ever splitting or leaving its section.
 *
 * Inside a section it swaps with the neighbouring exercise. An exercise that
 * IS its block (the unsectioned case) moves the block instead, within its
 * rank band — which for a day with no sections is the whole list, i.e. what
 * ↑/↓ has always done, only now a whole ramp at a time.
 *
 * Returns null when there is nowhere to go, which is also what disables the
 * button.
 */
export function moveEntry(
  blocks: PlanBlock[],
  entryKey: string,
  dir: -1 | 1,
): PlanBlock[] | null {
  const bi = blocks.findIndex((b) => b.entries.some((e) => e.key === entryKey));
  if (bi < 0) return null;
  const block = blocks[bi]!;
  if (block.entries.length > 1) {
    const ei = block.entries.findIndex((e) => e.key === entryKey);
    const to = ei + dir;
    if (to < 0 || to >= block.entries.length) return null;
    const entries = [...block.entries];
    const [moved] = entries.splice(ei, 1);
    entries.splice(to, 0, moved!);
    return blocks.map((b, i) => (i === bi ? { ...b, entries } : b));
  }
  const band = blockBand(blocks, block.key);
  if (band === null) return null;
  const to = bi + dir;
  if (to < band[0] || to > band[1]) return null;
  const next = [...blocks];
  const [moved] = next.splice(bi, 1);
  next.splice(to, 0, moved!);
  return next;
}
