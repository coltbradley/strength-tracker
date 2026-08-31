// Plan editor: everything about a future (or past) planned workout is
// editable here — the calendar date, the user's own pre-workout note, the
// week order, and the prescriptions themselves. Writes are online-only
// (planning happens at home); each action saves immediately and confirms
// with a toast so there is never an unsaved-state question.

import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import { NewExerciseSheet } from "../components/NewExerciseSheet";
import { getSetting } from "../lib/settings";
import { SetSchemeSheet, type SetGroup } from "../components/SetSchemeSheet";
import { Note } from "../components/Note";
import {
  addPrescriptionGroups,
  reorderPrescriptions,
  saveWorkoutAsTemplate,
  deletePlannedWorkout,
  deletePrescription,
  PlanEditRefused,
  duplicatePlannedWorkout,
  getExercises,
  getPlannedWorkouts,
  getResolvedPrescriptions,
  setPrescriptionSection,
  swapWorkoutOrder,
  updatePlannedWorkout,
  updatePrescription,
  weekOrder,
  type WorkoutList,
} from "../lib/data";
import {
  blockBand,
  blockRowIds,
  canonicalRowIds,
  entryBand,
  entryKeys,
  moveEntry,
  normalizeSection,
  planBlocks,
  reorderBlocks,
  reorderEntries,
  moveBlock,
  sectionUnit,
  type PlanBlock,
  type PlanEntry,
} from "../lib/sections";
import { reportError, toast } from "../lib/errors";
import {
  formatPlannedDate,
  formatRepRange,
  formatStoredTwin,
  todayLocalIso,
  workoutName,
} from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import { useDragList } from "../hooks/useDragList";
import { ExercisePicker } from "../components/ExercisePicker";
import { fromDisplay, stepKg, toDisplay } from "../lib/units";
import type {
  ExerciseRow,
  TrackingMode,
  PlannedWorkoutRow,
  PrescriptionPatch,
  ResolvedPrescriptionRow,
} from "../lib/types";

type LoadMode = "kg" | "pct" | "feel";

interface RxDraft {
  sets: number;
  reps_min: number;
  reps_max: number;
  mode: LoadMode;
  load_kg: number; // stored kg, meaningful in kg mode
  load_pct: number; // meaningful in pct mode
  rest_seconds: number;
  hasRest: boolean;
  /** 0 = not in a superset; 1-4 = group A-D */
  superset: number;
  /** "" = the main body of the workout */
  section: string;
  tracking: TrackingMode;
}

/**
 * Whether this row runs as a ramp — several prescriptions for the SAME
 * exercise inside one entry. Today renders those as one grouped entry
 * ("1×8 @60 · 1×6 @85 · 3×3 @112"), which is how a warmup ramp is expressed;
 * this editor keeps them as separate rows so each is editable. The marker
 * exists so the two screens visibly agree.
 */
function isRampRow(entry: PlanEntry, r: ResolvedPrescriptionRow): boolean {
  return entry.rows.filter((o) => o.exercise_id === r.exercise_id).length > 1;
}

/** "Superset A", the way a person says it. */
function supersetName(group: number): string {
  return `SUPERSET ${String.fromCharCode(64 + group)}`;
}

/** MAIN WORK is the null section: the body of the day, which needs no
 *  heading. Named here because three places offer it as a choice and it must
 *  read the same in all of them. */
const MAIN_LABEL = "MAIN WORK";

/** Sections the editor offers before anything the day already uses. */
const SECTION_SUGGESTIONS = ["Activations", "Abs", "Cooldown"];

function draftFrom(r: ResolvedPrescriptionRow): RxDraft {
  return {
    sets: r.sets,
    reps_min: r.reps_min,
    reps_max: r.reps_max,
    mode: r.load_kg !== null ? "kg" : r.load_pct_tm !== null ? "pct" : "feel",
    load_kg: r.load_kg ?? r.resolved_load_kg ?? 20,
    load_pct: r.load_pct_tm ?? 75,
    rest_seconds: r.rest_seconds ?? 180,
    hasRest: r.rest_seconds !== null,
    superset: r.superset_group ?? 0,
    section: r.section ?? "",
    tracking: r.tracking ?? "reps",
  };
}

/** Did the draft actually change anything? */
function unchanged(r: ResolvedPrescriptionRow, p: PrescriptionPatch): boolean {
  return (
    p.sets === r.sets &&
    p.reps_min === r.reps_min &&
    p.reps_max === r.reps_max &&
    (p.load_kg ?? null) === (r.load_kg ?? null) &&
    (p.load_pct_tm ?? null) === (r.load_pct_tm ?? null) &&
    (p.rest_seconds ?? null) === (r.rest_seconds ?? null) &&
    (p.superset_group ?? null) === (r.superset_group ?? null) &&
    (p.section ?? null) === (r.section ?? null) &&
    (p.tracking ?? "reps") === (r.tracking ?? "reps")
  );
}

function patchFrom(d: RxDraft): PrescriptionPatch {
  return {
    sets: d.sets,
    reps_min: d.reps_min,
    reps_max: Math.max(d.reps_min, d.reps_max),
    // 0 is bodyweight, not "unset": the schema says so
    // (`load_kg >= 0`, 0 = bodyweight) and a chin-up prescribed at 0 is a
    // real prescription. Clamping it up to 0.5 made bodyweight unexpressible.
    load_kg: d.mode === "kg" ? Math.max(0, d.load_kg) : null,
    load_pct_tm: d.mode === "pct" ? d.load_pct : null,
    rest_seconds: d.hasRest ? d.rest_seconds : null,
    superset_group: d.superset === 0 ? null : d.superset,
    section: d.section.trim() === "" ? null : d.section.trim(),
    tracking: d.tracking,
  };
}

const SUPERSET_CHOICES: [number, string][] = [
  [0, "NONE"],
  [1, "A"],
  [2, "B"],
  [3, "C"],
  [4, "D"],
];

export function Plan() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const unit = useUnit();

  const [list, setList] = useState<WorkoutList | null>(null);
  const [rx, setRx] = useState<ResolvedPrescriptionRow[] | null>(null);
  // local mirror of the date input: iOS fires change per picker-wheel tick,
  // so the write commits on blur (picker close), not per tick
  const [dateValue, setDateValue] = useState<string>("");
  const [dateDirty, setDateDirty] = useState(false);
  const [planNote, setPlanNote] = useState("");
  const [noteDirty, setNoteDirty] = useState(false);
  const [editingRx, setEditingRx] = useState<string | null>(null);
  const [draft, setDraft] = useState<RxDraft | null>(null);
  const [confirming, setConfirming] = useArmed(); // destructive action key
  const [searchOpen, setSearchOpen] = useState(false);
  /** Exercise chosen in the picker, awaiting its set scheme. */
  const [adding, setAdding] = useState<ExerciseRow | null>(null);
  /** The section an add started from, so "Add to ACTIVATIONS" adds INTO it
   *  rather than dropping the exercise in the main body to be filed later. */
  const [addingTo, setAddingTo] = useState<string | null>(null);
  /** Block key of the section whose panel is open (rename / add / dissolve). */
  const [sectionOpen, setSectionOpen] = useState<string | null>(null);
  const [sectionName, setSectionName] = useState("");
  /** null = not saving; a string = the name being typed */
  const [templateName, setTemplateName] = useState<string | null>(null);
  /** Tap a value to type it, in the row editor as well as the add sheet. */
  const [pad, setPad] = useState<PadRequest | null>(null);
  /** name typed in the picker that matched nothing they wanted */
  const [newName, setNewName] = useState<string | null>(null);
  const [allExercises, setAllExercises] = useState<ExerciseRow[]>([]);
  const [exercisesFailed, setExercisesFailed] = useState(false);
  const [duplicateDate, setDuplicateDate] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [labelValue, setLabelValue] = useState("");
  const [labelDirty, setLabelDirty] = useState(false);
  /** Set by addExercise so the reload that follows can open the new row's
   *  editor. Adding an exercise and then having to hunt for it was the
   *  complaint; landing in its editor is the answer. */
  const openAfterReload = useRef<string | null>(null);

  const workout: PlannedWorkoutRow | null =
    list?.workouts.find((w) => w.id === id) ?? null;
  // same order as the Today list, so "earlier/later" swaps with the row the
  // user actually sees next to this one
  const siblings = useMemo(
    () =>
      workout
        ? (list?.workouts ?? [])
            .filter((w) => w.program_id === workout.program_id)
            .sort(weekOrder)
        : [],
    [list, workout],
  );

  const reload = useCallback(() => {
    getPlannedWorkouts()
      .then((r) => setList(r.data))
      .catch((e: unknown) => reportError(e, "load plan"));
    if (id)
      getResolvedPrescriptions(id)
        .then((r) => setRx(r.data))
        .catch((e: unknown) => reportError(e, "load prescriptions"));
  }, [id]);

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    if (workout && !noteDirty) setPlanNote(workout.plan_note ?? "");
    if (workout && !dateDirty) setDateValue(workout.scheduled_date ?? "");
    if (workout && !labelDirty) setLabelValue(workout.label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workout?.id,
    workout?.plan_note,
    workout?.scheduled_date,
    workout?.label,
  ]);

  // Open the editor on the exercise that was just added, and bring it into
  // view. Runs when the reload that follows the insert delivers the new row.
  useEffect(() => {
    const wanted = openAfterReload.current;
    if (wanted === null || rx === null) return;
    const row = rx.find((r) => r.id === wanted);
    if (row === undefined) return;
    openAfterReload.current = null;
    setEditingRx(row.id);
    setDraft(draftFrom(row));
    setConfirming(null);
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-rx="${row.id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rx]);

  useEffect(() => {
    if (!searchOpen || allExercises.length > 0) return;
    setExercisesFailed(false);
    getExercises()
      .then((r) => setAllExercises(r.data))
      .catch((e: unknown) => {
        // the picker says so itself now instead of spinning forever
        setExercisesFailed(true);
        reportError(e, "load exercises");
      });
  }, [searchOpen, allExercises.length]);

  /** Who is already in each superset group, so the add sheet can say what a
   *  letter pairs with instead of leaving it to mean nothing. */
  const supersetMembers = useMemo(() => {
    const m: Record<number, string[]> = {};
    for (const r of rx ?? []) {
      if (r.superset_group === null) continue;
      (m[r.superset_group] ??= []).push(r.exercise_name);
    }
    return m;
  }, [rx]);

  /**
   * The day as parts, not rows.
   *
   * Everything below renders from this: a section exists once here, so it can
   * only be drawn once, and a ramp or a superset is one object, so nothing can
   * pick up half of it. See lib/sections.ts.
   */
  const blocks = useMemo(() => planBlocks(rx ?? []), [rx]);

  /** Long-press to drag, at both levels a day actually has: a whole part of
   *  the day (its heading, or a lone exercise), and one exercise inside a
   *  part. The ↑/↓ buttons stay — they are the keyboard and screen-reader
   *  path, and dragging is not available to either. */
  // Hooks must run before the early returns below, so the drop handlers cannot
  // close over `run`/`reload` (defined after them). They call through refs that
  // the render body fills in — the alternative is hoisting half the component.
  const onBlockDropRef = useRef<(keys: string[]) => void>(() => undefined);
  const onEntryDropRef = useRef<(keys: string[]) => void>(() => undefined);
  const blockDrag = useDragList(
    blocks.map((b) => b.key),
    (keys) => onBlockDropRef.current(keys),
    (key) => blockBand(blocks, key),
  );
  const draggedBlocks = useMemo(
    () => reorderBlocks(blocks, blockDrag.order),
    [blocks, blockDrag.order],
  );
  const entryDrag = useDragList(
    entryKeys(draggedBlocks),
    (keys) => onEntryDropRef.current(keys),
    (key) => entryBand(draggedBlocks, key),
  );

  /** The day in the order being dragged, not the order last loaded. */
  const shownBlocks = useMemo(
    () => reorderEntries(draggedBlocks, entryDrag.order),
    [draggedBlocks, entryDrag.order],
  );
  const entries = useMemo(
    () => shownBlocks.flatMap((b) => b.entries),
    [shownBlocks],
  );

  if (!id) return null;
  if (!list) return <div className="screen muted">Loading…</div>;
  if (!workout)
    return (
      <div className="screen">
        <p className="muted">This workout no longer exists.</p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => navigate("/")}
        >
          Back to Today
        </button>
      </div>
    );

  const run = async (what: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      reportError(e, what);
    } finally {
      setBusy(false);
    }
  };

  /**
   * A starting weight for the scheme sheet's steppers. An existing row for the
   * same exercise in this day wins — that is the ramp case, where the next
   * set-group is almost always near the last one. Otherwise the device's
   * fallback load, which is what the session screen would suggest anyway.
   */
  /** Store the row order a dragged layout implies. Whole blocks and whole
   *  entries move, so `position` is only ever rewritten for things that
   *  actually moved together. */
  const storeLayout = (next: PlanBlock[]) =>
    void run("reorder exercises", async () => {
      await reorderPrescriptions(workout.id, blockRowIds(next), rx ?? []);
      reload();
    });

  onBlockDropRef.current = (keys) => storeLayout(reorderBlocks(blocks, keys));
  onEntryDropRef.current = (keys) =>
    storeLayout(reorderEntries(draggedBlocks, keys));

  /**
   * Store what the editor RENDERS.
   *
   * `planBlocks` gathers a section's exercises under one heading and ranks
   * activations before the main body — so after any write that changes
   * grouping, the rendered day and the stored day differ until this lands.
   * Today and the session screen read the stored order, and two screens
   * describing different days is the bug this whole module exists to stop.
   */
  const settle = async (rows: ResolvedPrescriptionRow[]) => {
    await reorderPrescriptions(workout.id, canonicalRowIds(rows), rows);
  };

  /** Sections already used in this day, so naming one twice is a tap. */
  const knownSections = [
    ...new Set(
      (rx ?? [])
        .map((r) => r.section)
        .filter((x): x is string => Boolean(x && x.trim())),
    ),
  ];

  const startKgFor = (exerciseId: string): number => {
    const mine = (rx ?? []).filter((r) => r.exercise_id === exerciseId);
    const last = mine[mine.length - 1];
    return last?.resolved_load_kg ?? getSetting("fallbackLoad")[unit];
  };

  const saveDate = (value: string) =>
    void run("save date", async () => {
      if ((workout.scheduled_date ?? "") === value) {
        setDateDirty(false);
        return;
      }
      await updatePlannedWorkout(workout.id, {
        scheduled_date: value === "" ? null : value,
      });
      setDateDirty(false);
      toast(
        value === ""
          ? "Date cleared"
          : `Scheduled for ${formatPlannedDate(value)}`,
      );
      reload();
    });

  const saveNote = () =>
    void run("save plan note", async () => {
      const trimmed = planNote.trim();
      await updatePlannedWorkout(workout.id, {
        plan_note: trimmed === "" ? null : trimmed,
      });
      setNoteDirty(false);
      toast("Plan note saved");
      reload();
    });

  const move = (dir: -1 | 1) => {
    const i = siblings.findIndex((w) => w.id === workout.id);
    const other = siblings[i + dir];
    if (!other) return;
    void run("reorder", async () => {
      await swapWorkoutOrder(workout, other);
      toast("Order updated");
      reload();
    });
  };

  const duplicate = () =>
    void run("duplicate workout", async () => {
      await duplicatePlannedWorkout(workout, duplicateDate || null);
      toast(
        duplicateDate
          ? `Copied to ${formatPlannedDate(duplicateDate)}`
          : "Copied (unscheduled)",
      );
      setDuplicateDate("");
      reload();
    });

  const removeWorkout = () =>
    void run("delete workout", async () => {
      await deletePlannedWorkout(workout.id);
      toast("Workout deleted");
      navigate("/");
    });

  /**
   * Write an edited row, and carry a changed section to the whole exercise.
   *
   * A section holds whole exercises. Sectioning one row of a ramp used to put
   * its first bracket under the heading and leave the other two outside it,
   * and did the same to a superset — worse there, because the pairing IS the
   * prescription. `sectionUnit` says what "whole" means; only the section
   * travels, since every other field on this row is about this row.
   */
  const commitRx = async (
    r: ResolvedPrescriptionRow,
    patch: PrescriptionPatch,
  ) => {
    const rows = rx ?? [];
    const next = normalizeSection(patch.section);
    const group = patch.superset_group ?? null;
    const moved = next !== normalizeSection(r.section);
    const mates = moved
      ? sectionUnit(rows, r.id)
          .filter((o) => o.id !== r.id && normalizeSection(o.section) !== next)
          .map((o) => o.id)
      : [];
    await updatePrescription(r.id, workout.id, patch);
    await setPrescriptionSection(mates, workout.id, next);
    // A section or a letter says which PART of the day this belongs to, and
    // the editor has already redrawn it there. Land it, or Today would still
    // read the old order.
    if (moved || group !== (r.superset_group ?? null))
      await settle(
        rows.map((o) =>
          o.id === r.id
            ? { ...o, section: next, superset_group: group }
            : mates.includes(o.id)
              ? { ...o, section: next }
              : o,
        ),
      );
  };

  /**
   * Commit an edited row.
   *
   * Called on collapse rather than from a Save button. Everything else on this
   * screen saves as you go — the name, the date, the note all commit on blur —
   * so one section demanding a deliberate Save was the odd one out, and
   * forgetting it silently discarded the edit.
   *
   * `keepOpen` is for the reorder buttons, which must not close the row they
   * just moved.
   */
  const saveRx = (r: ResolvedPrescriptionRow, keepOpen = false) => {
    if (!draft) return Promise.resolve();
    const patch = patchFrom(draft);
    // Nothing changed: skip the write and the toast entirely, or merely opening
    // a row and closing it claims to have updated it.
    if (unchanged(r, patch)) {
      if (!keepOpen) {
        setEditingRx(null);
        setDraft(null);
      }
      return Promise.resolve();
    }
    return run("save exercise", async () => {
      await commitRx(r, patch);
      if (!keepOpen) {
        setEditingRx(null);
        setDraft(null);
      }
      reload();
    });
  };

  const removeRx = (r: ResolvedPrescriptionRow) =>
    void run("remove exercise", async () => {
      try {
        await deletePrescription(r.id, workout.id);
      } catch (e) {
        // The database refusing to cut logged sets loose from their day is
        // the system working, not breaking. Say what happened and stop —
        // reporting it would file an ordinary edit as an exception.
        if (e instanceof PlanEditRefused) {
          setConfirming(null);
          toast(e.message, "error");
          return;
        }
        throw e;
      }
      setConfirming(null);
      setEditingRx(null);
      toast(`${r.exercise_name} removed`);
      reload();
    });

  /**
   * Picking an exercise no longer writes a row. It opens the set scheme sheet,
   * which asks how many sets, what each weighs and which are warmups — the
   * three things a workout is actually made of. The old path dropped a bare
   * 3x8-by-feel row into the day and left you to find the editor.
   */
  const saveScheme = (ex: ExerciseRow, groups: SetGroup[]) =>
    void run("add exercise", async () => {
      // Consecutive prescriptions for the SAME exercise are a ramp: Today
      // renders them as one grouped entry ("3×5 · 3×3"), while this editor
      // keeps them as separate rows. That is deliberate — it is how a warmup
      // ramp is expressed — but it happened silently, so the two screens
      // appeared to disagree. Say it out loud instead.
      const last = (rx ?? [])[(rx ?? []).length - 1];
      const startsRamp = last !== undefined && last.exercise_id === ex.id;

      const newId = await addPrescriptionGroups(
        workout.id,
        ex.id,
        groups,
        rx ?? [],
      );
      // Appended last, which is wrong the moment it belongs to a part of the
      // day: an activation added at the end is an activation nobody does
      // first. Refetch and land it where the editor draws it.
      const section = normalizeSection(groups[0]?.section);
      if (section !== null)
        await settle((await getResolvedPrescriptions(workout.id)).data);
      // Only auto-expand a single-row add. A ramp is already fully specified
      // by the sheet; opening its first row would suggest it is not.
      if (groups.length === 1) openAfterReload.current = newId;
      setAdding(null);
      setAddingTo(null);
      const total = groups.reduce((n, g) => n + g.sets, 0);
      toast(
        startsRamp
          ? `${ex.name} added — it joins the ramp above it`
          : section !== null
            ? `${ex.name} added to ${section}`
            : `${ex.name}: ${total} ${total === 1 ? "set" : "sets"} added`,
      );
      reload();
    });

  /**
   * ↑/↓ move a whole EXERCISE, never a row.
   *
   * Moving one bracket of a ramp past the exercise above it split the ramp in
   * exactly the way dragging used to — same bug, quieter path. Inside a
   * section this swaps with the neighbouring exercise; an exercise that is a
   * part of the day on its own moves that part. `moveEntry` returns null when
   * there is nowhere to go, which is also what disables the button.
   */
  const moveExercise = (
    entry: PlanEntry,
    r: ResolvedPrescriptionRow,
    dir: -1 | 1,
  ) =>
    void run("reorder exercise", async () => {
      let rows = rx ?? [];
      // Commit first: moving a row used to discard whatever was typed in it.
      // The commit can itself re-rank the day, so the move is computed from
      // what the database holds afterwards, not from the stale render.
      if (editingRx === r.id && draft) {
        await commitRx(r, patchFrom(draft));
        rows = (await getResolvedPrescriptions(workout.id)).data;
      }
      const next = moveEntry(planBlocks(rows), entry.key, dir);
      if (next !== null)
        await reorderPrescriptions(workout.id, blockRowIds(next), rows);
      reload();
    });

  /** Rename a section from its heading: it is one name over several rows, so
   *  editing it on one row and hoping is not a thing a person should do. */
  const renameSection = (block: PlanBlock, name: string) =>
    void run("rename section", async () => {
      const next = normalizeSection(name);
      if (next === null || next === block.section) {
        setSectionOpen(null);
        return;
      }
      const ids = block.entries.flatMap((e) => e.rows.map((o) => o.id));
      await setPrescriptionSection(ids, workout.id, next);
      // A rename can change where the part runs — "Abs" renamed to "Cooldown"
      // belongs at the end now.
      await settle(
        (rx ?? []).map((o) =>
          ids.includes(o.id) ? { ...o, section: next } : o,
        ),
      );
      setSectionOpen(null);
      toast(`Renamed to ${next}`);
      reload();
    });

  /** Dissolve a section: its exercises stay, in order, as main work. */
  const dissolveSection = (block: PlanBlock) =>
    void run("remove section", async () => {
      const ids = block.entries.flatMap((e) => e.rows.map((o) => o.id));
      await setPrescriptionSection(ids, workout.id, null);
      await settle(
        (rx ?? []).map((o) =>
          ids.includes(o.id) ? { ...o, section: null } : o,
        ),
      );
      setSectionOpen(null);
      setConfirming(null);
      toast(`${block.section} removed — its exercises stay`);
      reload();
    });

  const saveTemplate = () =>
    void run("save template", async () => {
      const name = (templateName ?? "").trim() || workoutName(workout);
      await saveWorkoutAsTemplate(workout, name, rx ?? []);
      setTemplateName(null);
      toast(`Saved "${name}" — add it to any day from Today`);
    });

  const saveLabel = () =>
    void run("rename workout", async () => {
      const next = labelValue.trim();
      await updatePlannedWorkout(workout.id, {
        label: next.length === 0 ? null : next,
      });
      setLabelDirty(false);
      reload();
    });

  const idx = siblings.findIndex((w) => w.id === workout.id);
  const isToday = workout.scheduled_date === todayLocalIso();

  const loadDraftLabel =
    draft?.mode === "pct"
      ? `${draft.load_pct}% TM`
      : draft
        ? `${toDisplay(draft.load_kg, unit)} ${unit}`
        : "";

  return (
    <div className="screen">
      <button type="button" className="back-link" onClick={() => navigate("/")}>
        ‹ TODAY
      </button>
      <input
        className="input plan-title-input"
        value={labelValue}
        placeholder={workoutName(workout)}
        aria-label="workout name"
        onChange={(e) => {
          setLabelValue(e.target.value);
          setLabelDirty(true);
        }}
        onBlur={() => labelDirty && saveLabel()}
      />
      {workout.notes && <Note label="COACH" text={workout.notes} />}

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">EXERCISES</span>
          <span className="section-meta">{rx?.length ?? 0}</span>
        </div>
        {rx === null && <p className="muted">Loading…</p>}
        {/* Sections are the one feature of this editor you cannot see until
            you go looking for it. Say what they are, once, while there are
            none. */}
        {rx !== null && rx.length > 1 && knownSections.length === 0 && (
          <div className="microcopy">
            This day is one flat list. Sections break it into parts —
            activations, main work, abs — each with its own heading and its own
            place in the day. Open any exercise to put it in one.
          </div>
        )}
        {shownBlocks.map((block, bi) => (
          <Fragment key={block.key}>
            {/* MAIN WORK, above the first block of each run of unsectioned
                ones, once the day has any named part at all.

                Without it the day read as a nameless stretch, then ABS, then
                another nameless stretch: a section INTERRUPTED the day instead
                of dividing it, and nothing said where the main work began or
                ended. A flat day still gets no heading — a day with one part
                does not need to be told what the part is.

                A LABEL on a run, deliberately, and not a block of its own.
                `moveEntry` relies on an unsectioned exercise BEING its own
                block; that is what lets the arrows walk it through the whole
                day, and gathering main work into one block would confine it
                and silently change what those arrows do. A run that resumes
                after a named part gets its own heading rather than being
                folded into the first — two headings is the honest picture of a
                day that really does go main, then abs, then main. */}
            {block.section === null &&
              knownSections.length > 0 &&
              shownBlocks[bi - 1]?.section !== null && (
                <div className="plan-main-head">
                  <span className="plan-section-name">{MAIN_LABEL}</span>
                </div>
              )}
          <div
            className={[
              "plan-block",
              block.section !== null ? "plan-block-named" : "",
              blockDrag.dragging === block.key ? "block-dragging" : "",
              blockDrag.dragging !== null && blockDrag.overIndex === bi
                ? "block-over"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {/* A part of the day, drawn once as a divider with what is in it.
                The heading is also the handle: dragging it moves the whole
                part, and tapping it is how a section is renamed, added to or
                dissolved — a section you can only edit one row at a time is
                not a thing, it is a column value. */}
            {block.section !== null && (
              <>
                <button
                  type="button"
                  className="plan-section-head"
                  {...blockDrag.handlers(block.key, bi)}
                  onClick={() => {
                    setConfirming(null);
                    if (sectionOpen === block.key) {
                      // closing: commit the name the way a row commits
                      if (normalizeSection(sectionName) !== block.section)
                        renameSection(block, sectionName);
                      else setSectionOpen(null);
                      return;
                    }
                    setSectionName(block.section ?? "");
                    setSectionOpen(block.key);
                  }}
                >
                  <span className="plan-section-name">
                    {block.section.toUpperCase()}
                  </span>
                  <span className="plan-section-count">
                    {block.entries.length}{" "}
                    {block.entries.length === 1 ? "exercise" : "exercises"}
                  </span>
                  <span className="chev">
                    {sectionOpen === block.key ? "▾" : "▸"}
                  </span>
                </button>
                {sectionOpen === block.key && (
                  <div className="plan-section-detail">
                    {/* Commits when the panel closes, exactly as a row commits
                        when it collapses (see saveRx). A deliberate Rename
                        button was the one control on this screen that threw the
                        edit away if you forgot it. NOT on blur: tapping "Add
                        exercise here" blurs this input, and committing there
                        would close the panel out from under the tap. */}
                    <input
                      className="input"
                      aria-label="section name"
                      value={sectionName}
                      onChange={(e) =>
                        setSectionName(e.target.value.slice(0, 40))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") renameSection(block, sectionName);
                      }}
                    />
                    <div className="detail-actions">
                      {/* Adding INTO a part is the action this panel exists
                          for: an exercise you add and then file is an
                          exercise you decided about twice. */}
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => {
                          setAddingTo(block.section);
                          setSectionOpen(null);
                          setSearchOpen(true);
                        }}
                      >
                        Add exercise here
                      </button>
                      {/* ↑/↓ beside the drag, exactly as the exercise rows
                          have. Holding a heading to drag it is not something
                          anyone discovers, and drag with no alternative fails
                          WCAG 2.5.7. Same band as the drag, so a part can
                          never be moved somewhere the next render ranks it
                          straight back out of. */}
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={
                          busy || moveBlock(blocks, block.key, -1) === null
                        }
                        onClick={() => {
                          const next = moveBlock(blocks, block.key, -1);
                          if (next) storeLayout(next);
                        }}
                      >
                        ↑ Move up
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={
                          busy || moveBlock(blocks, block.key, 1) === null
                        }
                        onClick={() => {
                          const next = moveBlock(blocks, block.key, 1);
                          if (next) storeLayout(next);
                        }}
                      >
                        ↓ Move down
                      </button>
                      <button
                        type="button"
                        className={`btn ${confirming === block.key ? "btn-danger" : "btn-ghost"}`}
                        disabled={busy}
                        onClick={() =>
                          confirming === block.key
                            ? dissolveSection(block)
                            : setConfirming(block.key)
                        }
                      >
                        {confirming === block.key
                          ? "Remove heading?"
                          : "Remove heading"}
                      </button>
                    </div>
                    <div className="microcopy">
                      {confirming === block.key
                        ? "The heading goes; its exercises stay in the day, in this order, as main work."
                        : "The name saves when you close this. Hold the heading to drag the whole part. To take one exercise out, change its section."}
                    </div>
                  </div>
                )}
              </>
            )}
            {block.entries.map((entry) => {
              const ei = entries.findIndex((e) => e.key === entry.key);
              return (
                <div
                  key={entry.key}
                  className={[
                    "plan-entry",
                    entry.supersetGroup !== null ? "ss-group" : "",
                    entryDrag.dragging === entry.key ? "block-dragging" : "",
                    entryDrag.dragging !== null && entryDrag.overIndex === ei
                      ? "block-over"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  {...(block.section === null
                    ? blockDrag.handlers(block.key, bi)
                    : entryDrag.handlers(entry.key, ei))}
                >
                  {/* Labelled once, at the top of the run, instead of a letter
                      repeated on every row. "Superset A · 2 exercises" says
                      what is actually true; "A · " on two separate rows did
                      not. */}
                  {entry.supersetGroup !== null && (
                    <div className="ss-head">
                      {supersetName(entry.supersetGroup)}
                      <span className="ss-head-note">
                        {" · "}
                        {entry.exercises > 1
                          ? `${entry.exercises} exercises, alternated`
                          : "nothing else in it yet"}
                      </span>
                    </div>
                  )}
                  {entry.rows.map((r) => {
                    const editing = editingRx === r.id && draft;
                    return (
                      <div key={r.id} className="week-item" data-rx={r.id}>
              <button
                type="button"
                className="week-row week-row-rx"
                onClick={() => {
                  if (editingRx === r.id) {
                    void saveRx(r);
                  } else {
                    setEditingRx(r.id);
                    setDraft(draftFrom(r));
                    setConfirming(null);
                  }
                }}
              >
                <span className="week-label">
                  {r.exercise_name}
                  {isRampRow(entry, r) && (
                    <span className="rx-ramp"> · RAMP</span>
                  )}
                </span>
                <span className="week-state">
                  {r.tracking === "done" && (
                    <span className="rx-done">TICK · </span>
                  )}
                  {/* Warmup is worth saying on the collapsed row: it is the
                      difference between "you owe 5 working sets" and 3. */}
                  {r.set_type !== undefined && r.set_type !== "working" && (
                    <span className="rx-type">{r.set_type.toUpperCase()}</span>
                  )}
                  {r.sets} × {formatRepRange(r.reps_min, r.reps_max)}
                  {r.load_kg !== null
                    ? ` · ${toDisplay(r.load_kg, unit)} ${unit}`
                    : r.load_pct_tm !== null
                      ? ` · ${r.load_pct_tm}%`
                      : ""}
                </span>
                <span className="chev">{editingRx === r.id ? "▾" : "▸"}</span>
              </button>
              {editing && draft && (
                <div className="week-detail">
                  <Stepper
                    label="sets"
                    compact
                    onTapValue={() =>
                      setPad({
                        label: `SETS`,
                        action: "SET",
                        initial: String(draft.sets),
                        allowDecimal: false,
                        onCommit: (v) =>
                          setDraft({
                            ...draft,
                            sets: Math.min(20, Math.max(1, Math.round(v))),
                          }),
                        onCancel: () => setPad(null),
                      })
                    }
                    display={`${draft.sets} ${draft.sets === 1 ? "set" : "sets"}`}
                    value={draft.sets}
                    min={1}
                    max={20}
                    onChange={(v) =>
                      setDraft({ ...draft, sets: Math.round(v) })
                    }
                    steps={[
                      { label: "−", delta: -1 },
                      { label: "+", delta: 1 },
                    ]}
                  />
                  <Stepper
                    label="reps min"
                    compact
                    onTapValue={() =>
                      setPad({
                        label: `REPS MIN`,
                        action: "SET",
                        initial: String(draft.reps_min),
                        allowDecimal: false,
                        onCommit: (v) =>
                          setDraft({
                            ...draft,
                            reps_min: Math.min(100, Math.max(1, Math.round(v))),
                          }),
                        onCancel: () => setPad(null),
                      })
                    }
                    display={`${draft.reps_min} reps min`}
                    value={draft.reps_min}
                    min={1}
                    max={100}
                    onChange={(v) =>
                      setDraft({ ...draft, reps_min: Math.round(v) })
                    }
                    steps={[
                      { label: "−", delta: -1 },
                      { label: "+", delta: 1 },
                    ]}
                  />
                  <Stepper
                    label="reps max"
                    compact
                    onTapValue={() =>
                      setPad({
                        label: `REPS MAX`,
                        action: "SET",
                        initial: String(
                          Math.max(draft.reps_min, draft.reps_max),
                        ),
                        allowDecimal: false,
                        onCommit: (v) =>
                          setDraft({
                            ...draft,
                            reps_max: Math.min(
                              100,
                              Math.max(draft.reps_min, Math.round(v)),
                            ),
                          }),
                        onCancel: () => setPad(null),
                      })
                    }
                    display={`${Math.max(draft.reps_min, draft.reps_max)} reps max`}
                    value={Math.max(draft.reps_min, draft.reps_max)}
                    min={draft.reps_min}
                    max={100}
                    onChange={(v) =>
                      setDraft({ ...draft, reps_max: Math.round(v) })
                    }
                    steps={[
                      { label: "−", delta: -1 },
                      { label: "+", delta: 1 },
                    ]}
                  />

                  <div className="seg seg-types">
                    {(
                      [
                        ["kg", unit.toUpperCase()],
                        ["pct", "% TM"],
                        ["feel", "BY FEEL"],
                      ] as [LoadMode, string][]
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        className={`seg-btn ${draft.mode === mode ? "seg-on" : ""}`}
                        onClick={() => setDraft({ ...draft, mode })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {draft.mode === "kg" && (
                    <Stepper
                      label="load"
                      compact
                      onTapValue={() =>
                        setPad({
                          label: `LOAD IN ${unit.toUpperCase()}`,
                          action: "SET",
                          initial: String(toDisplay(draft.load_kg, unit)),
                          allowDecimal: true,
                          onCommit: (v) =>
                            setDraft({
                              ...draft,
                              load_kg: Math.min(
                                999,
                                Math.max(0, fromDisplay(v, unit)),
                              ),
                            }),
                          onCancel: () => setPad(null),
                        })
                      }
                      display={loadDraftLabel}
                      subText={formatStoredTwin(draft.load_kg, unit)}
                      value={draft.load_kg}
                      min={0}
                      max={999}
                      onChange={(v) => setDraft({ ...draft, load_kg: v })}
                      snap
                      steps={[
                        {
                          label: "−",
                          delta: -stepKg(unit, false),
                          announce: `${toDisplay(stepKg(unit, false), unit)} ${unit}`,
                        },
                        {
                          label: "+",
                          delta: stepKg(unit, false),
                          announce: `${toDisplay(stepKg(unit, false), unit)} ${unit}`,
                        },
                      ]}
                    />
                  )}
                  {draft.mode === "pct" && (
                    <Stepper
                      label="percent of training max"
                      compact
                      onTapValue={() =>
                        setPad({
                          label: `PERCENT OF TRAINING MAX`,
                          action: "SET",
                          initial: String(draft.load_pct),
                          allowDecimal: true,
                          onCommit: (v) =>
                            setDraft({
                              ...draft,
                              load_pct: Math.min(200, Math.max(2.5, v)),
                            }),
                          onCancel: () => setPad(null),
                        })
                      }
                      display={loadDraftLabel}
                      value={draft.load_pct}
                      min={2.5}
                      max={200}
                      onChange={(v) => setDraft({ ...draft, load_pct: v })}
                      steps={[
                        { label: "−", delta: -2.5 },
                        { label: "+", delta: 2.5 },
                      ]}
                    />
                  )}

                  {/* Which PART of the day this belongs to. Picking one
                      moves the whole exercise there and gives the part a
                      heading — it is not a label on a row. */}
                  <div className="section-head">
                    <span className="field-label">PART OF THE DAY</span>
                  </div>
                  <div className="seg seg-types">
                    {["", ...knownSections, ...SECTION_SUGGESTIONS]
                      .filter((v, j, a) => a.indexOf(v) === j)
                      .map((secName) => (
                        <button
                          key={secName || "none"}
                          type="button"
                          className={`seg-btn ${draft.section === secName ? "seg-on" : ""}`}
                          onClick={() =>
                            setDraft({ ...draft, section: secName })
                          }
                        >
                          {secName === "" ? MAIN_LABEL : secName.toUpperCase()}
                        </button>
                      ))}
                  </div>
                  <input
                    className="input"
                    aria-label="section name"
                    placeholder="Or type a section name"
                    value={draft.section}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        section: e.target.value.slice(0, 40),
                      })
                    }
                  />
                  <div className="microcopy">
                    {entry.rows.length > 1
                      ? `A section holds whole exercises, so this moves all ${entry.rows.length} rows of the ${entry.supersetGroup !== null ? "superset" : "ramp"} into it.`
                      : `${MAIN_LABEL} is the body of the day and needs no heading. A named part gets one, and runs where its name says it does.`}
                  </div>

                  <div className="section-head">
                    <span className="field-label">HOW IT IS LOGGED</span>
                  </div>
                  <div className="seg seg-types">
                    <button
                      type="button"
                      className={`seg-btn ${draft.tracking === "reps" ? "seg-on" : ""}`}
                      onClick={() => setDraft({ ...draft, tracking: "reps" })}
                    >
                      WEIGHT & REPS
                    </button>
                    <button
                      type="button"
                      className={`seg-btn ${draft.tracking === "done" ? "seg-on" : ""}`}
                      onClick={() => setDraft({ ...draft, tracking: "done" })}
                    >
                      JUST TICK IT OFF
                    </button>
                  </div>

                  <div className="section-head">
                    <span className="field-label">SUPERSET</span>
                  </div>
                  {/* A bare "None A B C D" said nothing about what a letter
                      meant or that it pairs this exercise with ANOTHER one.
                      The letter is a group name: putting two exercises in the
                      same group is the whole feature, and the editor never
                      said so or showed you who you had joined. */}
                  <div className="microcopy">
                    Put two exercises in the same group to alternate between
                    them, resting once at the end rather than after each.
                  </div>
                  <div className="seg seg-types">
                    {SUPERSET_CHOICES.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`seg-btn ${draft.superset === value ? "seg-on" : ""}`}
                        onClick={() => setDraft({ ...draft, superset: value })}
                      >
                        {label === "NONE" ? "None" : label}
                      </button>
                    ))}
                  </div>
                  {draft.superset !== 0 &&
                    (() => {
                      const mates = (rx ?? []).filter(
                        (o) =>
                          o.id !== r.id && o.superset_group === draft.superset,
                      );
                      const letter = String.fromCharCode(64 + draft.superset);
                      return (
                        <div className="ss-pairing">
                          {mates.length === 0
                            ? `Group ${letter} — nothing else is in it yet. Put another exercise in ${letter} to pair them.`
                            : `Alternates with ${mates.map((m) => m.exercise_name).join(", ")}.`}
                        </div>
                      );
                    })()}

                  <div className="seg seg-types">
                    <button
                      type="button"
                      className={`seg-btn ${draft.hasRest ? "seg-on" : ""}`}
                      onClick={() => setDraft({ ...draft, hasRest: true })}
                    >
                      TIMED REST
                    </button>
                    <button
                      type="button"
                      className={`seg-btn ${!draft.hasRest ? "seg-on" : ""}`}
                      onClick={() => setDraft({ ...draft, hasRest: false })}
                    >
                      NO TARGET
                    </button>
                  </div>
                  {draft.hasRest && (
                    <Stepper
                      label="rest seconds"
                      compact
                      display={`${draft.rest_seconds}s rest`}
                      value={draft.rest_seconds}
                      min={0}
                      max={3600}
                      onChange={(v) =>
                        setDraft({ ...draft, rest_seconds: Math.round(v) })
                      }
                      steps={[
                        { label: "−", delta: -15 },
                        { label: "+", delta: 15 },
                      ]}
                    />
                  )}

                  {/* Order is part of the plan: an exercise added last used
                      to be stuck last, with nothing anywhere that writes
                      `position`. */}
                  <div className="section-head">
                    <span className="field-label">ORDER</span>
                    <span className="section-meta">
                      {ei + 1} of {entries.length}
                    </span>
                  </div>
                  <div className="chip-row">
                    <button
                      type="button"
                      className="chip"
                      disabled={
                        busy || moveEntry(shownBlocks, entry.key, -1) === null
                      }
                      onClick={() => moveExercise(entry, r, -1)}
                    >
                      ↑ Move up
                    </button>
                    <button
                      type="button"
                      className="chip"
                      disabled={
                        busy || moveEntry(shownBlocks, entry.key, 1) === null
                      }
                      onClick={() => moveExercise(entry, r, 1)}
                    >
                      ↓ Move down
                    </button>
                  </div>
                  {block.section !== null && (
                    <div className="microcopy">
                      Moves it within {block.section}. To take it out, pick a
                      different section above.
                    </div>
                  )}

                  <div className="detail-actions">
                    {/* Saves on collapse; this is the same action with a
                        label, for anyone who wants to press something. */}
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void saveRx(r)}
                    >
                      Done
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setEditingRx(null);
                        setDraft(null);
                      }}
                    >
                      Discard changes
                    </button>
                    {/* DELETE, not Remove: this drops the prescription from
                        the database. Session's UNDO ADD is the reversible one. */}
                    <button
                      type="button"
                      className={`btn ${confirming === `rx:${r.id}` ? "btn-danger" : "btn-ghost"}`}
                      disabled={busy}
                      onClick={() =>
                        confirming === `rx:${r.id}`
                          ? removeRx(r)
                          : setConfirming(`rx:${r.id}`)
                      }
                    >
                      {confirming === `rx:${r.id}`
                        ? "Delete exercise?"
                        : "Delete exercise"}
                    </button>
                  </div>
                  {confirming === `rx:${r.id}` && (
                    <div className="microcopy">
                      Removes this exercise from the planned day. Sets you have
                      already logged against it are not touched.
                    </div>
                  )}
                </div>
              )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          </Fragment>
        ))}
        <button
          type="button"
          className="btn btn-outline-ink btn-block"
          onClick={() => {
            setAddingTo(null);
            setSearchOpen(true);
          }}
        >
          Add exercise
        </button>

        {/* The planning sequence had no end. You added exercises one at a time
            and then just... stopped, with no signal that the day was done or
            that any of it had saved. Everything below this point (date, note,
            duplicate, delete) is an adjustment, not a step, so the finishing
            action belongs here rather than at the very bottom of the screen. */}
        <button
          type="button"
          className="btn btn-primary btn-block plan-done"
          onClick={() => navigate("/")}
        >
          Done planning
        </button>
        <div className="microcopy">
          Everything here saves as you go. This just takes you back to Today.
        </div>
      </section>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">SCHEDULED DAY</span>
          {isToday && <span className="section-meta">TODAY</span>}
        </div>
        <div className="date-row">
          <input
            className="input date-input"
            type="date"
            value={dateValue}
            onChange={(e) => {
              setDateValue(e.target.value);
              setDateDirty(true);
            }}
            onBlur={() => dateDirty && saveDate(dateValue)}
          />
          {!isToday && (
            <button
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => {
                setDateValue(todayLocalIso());
                saveDate(todayLocalIso());
              }}
            >
              Today
            </button>
          )}
        </div>
        {dateValue === "" ? (
          <div className="microcopy microcopy-warn">
            Not on the calendar. A day with no date does not appear on the week
            strip at all — pick one so this workout is findable.
          </div>
        ) : (
          <div className="microcopy">Start unlocks on the scheduled day.</div>
        )}
        <div className="chip-row">
          <button
            type="button"
            className="chip"
            disabled={idx <= 0 || busy}
            onClick={() => move(-1)}
          >
            ↑ Earlier
          </button>
          <button
            type="button"
            className="chip"
            disabled={idx < 0 || idx >= siblings.length - 1 || busy}
            onClick={() => move(1)}
          >
            ↓ Later
          </button>
        </div>
      </section>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">PLAN NOTE</span>
          {noteDirty && <span className="section-meta">UNSAVED</span>}
        </div>
        <textarea
          className="input note-input"
          placeholder="What's the intent for this one? Cues, targets, context…"
          rows={3}
          value={planNote}
          onChange={(e) => {
            setPlanNote(e.target.value);
            setNoteDirty(true);
          }}
          onBlur={() => noteDirty && saveNote()}
        />
        <div className="microcopy">Saved automatically.</div>
      </section>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">SAVE AS TEMPLATE</span>
        </div>
        {templateName === null ? (
          <button
            type="button"
            className="btn btn-secondary btn-block"
            disabled={busy || (rx ?? []).length === 0}
            onClick={() => setTemplateName(workoutName(workout))}
          >
            Save this workout
          </button>
        ) : (
          <>
            <input
              className="input"
              value={templateName}
              aria-label="template name"
              placeholder="Push A"
              autoFocus
              onChange={(e) => setTemplateName(e.target.value)}
            />
            <div className="detail-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setTemplateName(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={saveTemplate}
              >
                Save
              </button>
            </div>
          </>
        )}
        <div className="microcopy">
          Keeps this workout to reuse on any day. When you add it, the weights
          come from the last time you actually did each exercise, not from
          today’s numbers.
        </div>
      </section>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">DUPLICATE TO ANOTHER DAY</span>
        </div>
        <div className="date-row">
          <input
            className="input date-input"
            type="date"
            value={duplicateDate}
            onChange={(e) => setDuplicateDate(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={duplicate}
          >
            Duplicate
          </button>
        </div>
        <div className="microcopy">
          Copies this workout and its exercises onto the chosen day. Leave the
          date empty to copy it unscheduled.
        </div>
      </section>

      <section className="rule-section">
        <button
          type="button"
          className={`btn btn-block ${confirming === "workout" ? "btn-danger" : "btn-ghost"}`}
          disabled={busy}
          onClick={() =>
            confirming === "workout"
              ? removeWorkout()
              : setConfirming("workout")
          }
        >
          {confirming === "workout" ? "Delete workout?" : "Delete workout"}
        </button>
        {confirming === "workout" && (
          <div className="microcopy">
            Removes the planned day and its exercises. Logged sessions are not
            touched. Prefer Skip if it just isn’t happening this week.
          </div>
        )}
      </section>

      {searchOpen && (
        <ExercisePicker
          title="ADD EXERCISE"
          exercises={allExercises}
          failed={exercisesFailed}
          onPick={(ex) => {
            setSearchOpen(false);
            setAdding(ex);
          }}
          onAddNew={(q) => {
            setSearchOpen(false);
            setNewName(q);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {pad && (
        <NumberPad
          req={{
            ...pad,
            onCommit: (v) => {
              pad.onCommit(v);
              setPad(null);
            },
          }}
        />
      )}

      {newName !== null && (
        <NewExerciseSheet
          initialName={newName}
          exercises={allExercises}
          onPickExisting={(ex) => {
            setNewName(null);
            setAdding(ex);
          }}
          onCreated={(ex) => {
            setAllExercises((prev) => [...prev, ex]);
            setNewName(null);
            // Straight into the scheme sheet: they came here to add it to the
            // day, not to curate a library.
            setAdding(ex);
          }}
          onClose={() => setNewName(null)}
        />
      )}

      {adding && (
        <SetSchemeSheet
          exerciseName={adding.name}
          supersetMembers={supersetMembers}
          knownSections={knownSections}
          initialSection={addingTo}
          unit={unit}
          startKg={startKgFor(adding.id)}
          busy={busy}
          onCancel={() => {
            setAdding(null);
            setAddingTo(null);
          }}
          onSave={(groups) => saveScheme(adding, groups)}
        />
      )}
    </div>
  );
}
