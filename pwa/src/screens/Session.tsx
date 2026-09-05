// Set entry — the core screen. The workout is ONE accordion list: every
// exercise visible, exactly one open at a time, the logging surface lives
// inside the open item. Everything the screen needs is served from the
// IndexedDB cache written at session start (with a best-effort refresh when
// the prescription snapshot is empty), so it works fully offline mid-gym.
// Sets are append-only: a mistake is corrected by voiding and relogging.
//
// State notes (preserved from the review rounds):
// - Entries are keyed by prescription id (or `extra:<exercise_id>`), so the
//   same exercise under two prescriptions stays two distinct entries.
//   set_index stays scoped per EXERCISE across entries.
// - Every logged set must be visible somewhere: sets whose prescription_id
//   is null or dangling are claimed by the first rx entry for their
//   exercise, or get a synthesized fallback entry.
// - `setsRef` is the synchronous source of truth for logged sets: log taps
//   compute set_index from it atomically; bootstrap merges INTO it by id.
// - Rest: the timer starts when a set is logged; the NEXT set records the
//   elapsed rest (append-only). Voiding the set that started the clock
//   cancels it. The clock survives Home round-trips via the cache.
// - Supersets: consecutive rx entries sharing superset_group get A1/A2 tags
//   and a bracket rail. Suggestion only — logging order is never enforced.
// - Per-set notes live in set_notes (editable, last-write-wins), cached per
//   session and queued through the outbox like everything else.
// - Load entry: `entryKg` is what the user types, which on a per-side
//   movement is ONE side. `sets.load_kg` always stores the total, and
//   `load_entry` records which it was — the resolution chain and the
//   arithmetic both live in lib/loadEntry.ts.

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { Stepper, type StepDef } from "../components/Stepper";
import { Note } from "../components/Note";
import { RestTimer, type ActiveRest } from "../components/RestTimer";
import { SetRow } from "../components/SetRow";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import { PlateSheet } from "../components/PlateSheet";
import { ExercisePicker } from "../components/ExercisePicker";
import { NewExerciseSheet } from "../components/NewExerciseSheet";
import { prefersReducedMotion, useKeyboardInset } from "../components/Sheet";
import { cacheDelete, cacheGet, cacheSet, cacheKeys } from "../lib/db";
import {
  getExercises,
  getLastActuals,
  getResolvedPrescriptions,
  getServerSessionSets,
  getSetNotesByIds,
  mergeSets,
  type LastActuals,
} from "../lib/data";
import {
  bracketFor,
  buildEntries,
  isLocalBracket,
  setsForEntry as setsForEntryOf,
  supersetInfo as supersetInfoOf,
  entryMet,
  plannedExerciseId,
  progressSets,
  supersetPartner as supersetPartnerOf,
  targetSets,
  warmupSets,
  workingSets,
  type BracketKind,
  type ExerciseEntry,
  type ExtraExercise,
  type Substitutions,
} from "../lib/entries";
import { SetSchemeSheet, type SetGroup } from "../components/SetSchemeSheet";
import { outbox } from "../lib/sync";
import { uuid } from "../lib/uuid";
import { correctedSet, isNoopCorrection } from "../lib/corrections";
import { getPrefillFallback, prefillSet } from "../lib/prefill";
import { split } from "../lib/plates";
import {
  formatClock,
  formatPlate,
  formatRepRange,
  formatRxTarget,
  formatStoredTwin,
  rxHasNoTm,
} from "../lib/format";
import { reportError, toast } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import {
  useAutoStartRest,
  useExerciseBarKg,
  useExercisePref,
  useExerciseRestSeconds,
  usePlatesOnHand,
} from "../hooks/useSettings";
import { setExerciseLoadEntry } from "../lib/settings";
import { useWakeLock } from "../hooks/useWakeLock";
import { unlockRestCue } from "../lib/restCue";
import {
  enteredKg,
  loadEntryForSet,
  offersLoadEntry,
  resolveLoadEntry,
  totalKg,
} from "../lib/loadEntry";
import { fromDisplay, stepKgFor, toDisplay, type Unit } from "../lib/units";
import type {
  ActiveSession,
  ExerciseRow,
  LoadEntry,
  ResolvedPrescriptionRow,
  SetInsert,
  SetType,
} from "../lib/types";

/** Cached mirror of the rest clock. targetSeconds null = strip dismissed but
 *  the clock still runs for rest_seconds_actual recording. */
interface RestCache {
  startedAt: number;
  targetSeconds: number | null;
  forLabel: string | null;
}

type PadKind = "load" | "reps" | "rest";
interface PadSpec {
  kind: PadKind;
  fromPlates?: boolean;
}

// backoff stays a legal DB value (legacy sets render fine); it's just no
// longer offered — warmup or working covers how the coach programs
const SET_TYPES: SetType[] = ["warmup", "working"];
const LOG_LOCK_MS = 400;
// DB checks: reps between 0 and 100; rest_seconds_actual <= 3600
const MAX_REPS = 100;
const MAX_LOAD_KG = 999;
const MAX_REST_SECONDS = 3600;

export function Session() {
  const navigate = useNavigate();
  const unit = useUnit();
  const autoStartRest = useAutoStartRest();
  const inventory = usePlatesOnHand(unit);

  const [active, setActive] = useState<ActiveSession | null | undefined>(
    undefined,
  );
  const [rx, setRx] = useState<ResolvedPrescriptionRow[]>([]);
  const [extras, setExtras] = useState<ExtraExercise[]>([]);
  /**
   * Exercises being done in place of the ones the plan named, entry key ->
   * substitution. Device-local and session-scoped, the same class of fact as
   * `extras` and `skips`: today the cable station was taken, which says
   * nothing about the plan and must never be written back into it.
   *
   * The split this produces — see `ExerciseEntry.substitutedFor` — is that
   * `sets.exercise_id` becomes the movement actually lifted while
   * `sets.prescription_id` stays the planned bracket. History and e1RM
   * therefore describe what happened, and `v_adherence` still credits the
   * slot the plan asked for.
   */
  const [subs, setSubs] = useState<Substitutions>({});
  /** exercise chosen mid-session, awaiting its declared scheme */
  const [declaring, setDeclaring] = useState<ExerciseRow | null>(null);
  /** name typed in the picker that matched nothing they wanted */
  const [newName, setNewName] = useState<string | null>(null);
  /** what the picker (and the create sheet behind it) is FOR: adding an
   *  exercise the plan never mentioned, or swapping the open one. Same two
   *  sheets, two destinations — a substitute the library lacks must not
   *  dead-end any more than an addition does. */
  const [picking, setPicking] = useState<"add" | "swap">("add");
  const [sets, setSets] = useState<SetInsert[]>([]);
  const [setsLoaded, setSetsLoaded] = useState(false);
  // The bootstrap RAN and FAILED — which is not the same state as "hasn't
  // finished yet". `setsRef` is empty because we could not find out what is
  // in it, not because nothing is there, and logging against an empty list
  // computes set_index 0 for an exercise that already has sets. Nothing
  // downstream catches that: there is no unique constraint on
  // (session_id, exercise_id, set_index), and `sets` is append-only, so the
  // duplicate index would stand in LOGGED and in History forever. Same shape
  // as `exercisesFailed` below — a failure the screen tells the user about
  // instead of quietly acting on bad data.
  const [setsFailed, setSetsFailed] = useState(false);
  const [lastActuals, setLastActuals] = useState<LastActuals>({});
  const [equipMap, setEquipMap] = useState<Record<string, string | null>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);

  // The number the USER types. On a per-side exercise it is one side; the
  // total that reaches `sets.load_kg` is derived at the edges (see
  // lib/loadEntry.ts). Seeded from the configured fallback, never a literal.
  const [entryKg, setEntryKg] = useState(() => getPrefillFallback().loadKg);
  const [reps, setReps] = useState(() => getPrefillFallback().reps);
  const [setType, setSetType] = useState<SetType>("working");
  const [logLocked, setLogLocked] = useState(false);

  const [rest, setRest] = useState<ActiveRest | null>(null);
  // survives DONE so the next log can still record elapsed rest
  const restRef = useRef<{ startedAt: number } | null>(null);

  // corrections: voided set ids (append-only voiding) and skipped entry keys
  const [voids, setVoids] = useState<Set<string>>(new Set());
  const [skips, setSkips] = useState<Set<string>>(new Set());
  const [voidArm, setVoidArm] = useArmed();
  // The set being CORRECTED, with the stepper values it displaced so Cancel
  // can put them back. A correction is a void plus a new row at the same
  // index (lib/corrections.ts); this is only the screen's side of it.
  const [editing, setEditing] = useState<{
    set: SetInsert;
    staged: { entryKg: number; reps: number; setType: SetType };
  } | null>(null);

  // per-set notes (set_id -> note); "" = cleared
  const [setNotes, setSetNotes] = useState<Record<string, string>>({});
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const [dropArm, setDropArm] = useArmed();
  // the one keyboard-covered surface that is not a sheet: the per-set note
  // editor sits deep in the scroller with its Save/Cancel row underneath
  const kbInset = useKeyboardInset();
  const [sheet, setSheet] = useState<"search" | "swap" | "plates" | null>(null);
  const [pad, setPad] = useState<PadSpec | null>(null);
  const [allExercises, setAllExercises] = useState<ExerciseRow[]>([]);
  const [exercisesFailed, setExercisesFailed] = useState(false);

  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // The bootstrap load can come up empty (first run, offline, cold cache);
  // opening a picker retries rather than showing a lying spinner. Both
  // pickers, because a swap needs the library exactly as much as an add does.
  useEffect(() => {
    if ((sheet !== "search" && sheet !== "swap") || allExercises.length > 0)
      return;
    let cancelled = false;
    setExercisesFailed(false);
    getExercises()
      .then((r) => {
        if (cancelled) return;
        setAllExercises(r.data);
        setEquipMap(Object.fromEntries(r.data.map((e) => [e.id, e.equipment])));
      })
      .catch(() => {
        if (!cancelled) setExercisesFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  const sessionId = active?.id ?? null;

  // Hold the screen awake for exactly as long as a session is open. A rest
  // interval outlasts every default auto-lock, so without this the strip
  // counts down on a dark screen and the lifter has to unlock the phone to
  // find out rest is over. Scoped to the session rather than the app because
  // browsing history or editing a plan has no claim on somebody's battery.
  // Entirely best-effort — see the hook.
  useWakeLock(sessionId !== null);

  // Synchronous source of truth for logged sets.
  const setsRef = useRef<SetInsert[]>([]);
  const applySets = useCallback(
    (updater: (prev: SetInsert[]) => SetInsert[]): SetInsert[] => {
      setsRef.current = updater(setsRef.current);
      setSets(setsRef.current);
      return setsRef.current;
    },
    [],
  );

  // ---- bootstrap -----------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let a: ActiveSession | null | undefined;
        try {
          a = await cacheGet<ActiveSession>(cacheKeys.activeSession);
        } catch (e) {
          // a broken cache read must not strand the screen on "Loading…"
          reportError(e, "read active session");
          a = null;
        }
        if (cancelled) return;
        if (!a) {
          setActive(null);
          return;
        }
        setActive(a);
        const [
          rxCachedRaw,
          extrasCached,
          voidsCached,
          skipsCached,
          subsCached,
          restCached,
          notesCached,
          actuals,
          exercises,
        ] = await Promise.all([
          cacheGet<ResolvedPrescriptionRow[]>(cacheKeys.sessionRx(a.id)),
          cacheGet<ExtraExercise[]>(cacheKeys.sessionExtras(a.id)),
          cacheGet<string[]>(cacheKeys.sessionVoids(a.id)),
          cacheGet<string[]>(cacheKeys.sessionSkips(a.id)),
          cacheGet<Substitutions>(cacheKeys.sessionSwaps(a.id)),
          cacheGet<RestCache>(cacheKeys.sessionRest(a.id)),
          cacheGet<Record<string, string>>(cacheKeys.sessionSetNotes(a.id)),
          getLastActuals(a.id).catch(() => ({ data: {} as LastActuals })),
          getExercises().catch(() => ({ data: [] as ExerciseRow[] })),
        ]);
        if (cancelled) return;
        // An empty prescription snapshot is usually an offline/cold start
        // that failed silently — retry now that we may be online, and heal
        // the cache so the session isn't permanently target-less.
        let rxCached = rxCachedRaw ?? [];
        if (rxCached.length === 0 && a.planned_workout_id) {
          try {
            const fresh = await getResolvedPrescriptions(a.planned_workout_id);
            if (fresh.data.length > 0) {
              rxCached = fresh.data;
              await cacheSet(cacheKeys.sessionRx(a.id), fresh.data);
            }
          } catch {
            // still offline: by-feel logging, prefill from history
          }
        }
        if (cancelled) return;
        // rehydrate the rest clock (lost otherwise on Home round-trips and
        // page evictions); a clock past the recordable window is dropped
        if (
          restCached &&
          (Date.now() - restCached.startedAt) / 1000 <= MAX_REST_SECONDS
        ) {
          restRef.current = { startedAt: restCached.startedAt };
          if (restCached.targetSeconds !== null) {
            setRest({
              startedAt: restCached.startedAt,
              targetSeconds: restCached.targetSeconds,
              forLabel: restCached.forLabel ?? "",
            });
          }
        }
        setRx(rxCached);
        setExtras(extrasCached ?? []);
        const voided = new Set(voidsCached ?? []);
        setVoids(voided);
        setSkips(new Set(skipsCached ?? []));
        setSubs(subsCached ?? {});
        setSetNotes(notesCached ?? {});
        setLastActuals(actuals.data);
        setEquipMap(
          Object.fromEntries(exercises.data.map((e) => [e.id, e.equipment])),
        );
        setAllExercises(exercises.data);
        // Read the local copy BEFORE the server read overwrites the cache:
        // `load_entry` is written by this device and is not in every server
        // column list, and an absent column must never be read back as
        // "total" — that would silently double a per-side set's display.
        const localSets =
          (await cacheGet<SetInsert[]>(cacheKeys.sessionSets(a.id))) ?? [];
        const [server, pending] = await Promise.all([
          getServerSessionSets(a.id),
          outbox.pendingSets(a.id),
        ]);
        if (cancelled) return;
        const knownEntry = new Map<string, LoadEntry>();
        for (const s of [...localSets, ...pending])
          if (s.load_entry != null) knownEntry.set(s.id, s.load_entry);
        const merged = applySets((prev) =>
          mergeSets(mergeSets(server, pending), prev)
            .filter((s) => !voided.has(s.id))
            .map((s) =>
              s.load_entry != null
                ? s
                : { ...s, load_entry: knownEntry.get(s.id) ?? null },
            ),
        );
        // re-cache the repaired list; the server read just clobbered it
        cacheSet(cacheKeys.sessionSets(a.id), merged).catch((e: unknown) =>
          reportError(e, "cache session sets"),
        );
        // notes may have been written on another device — best-effort merge
        getSetNotesByIds(merged.map((s) => s.id))
          .then((fresh) => {
            if (cancelled || Object.keys(fresh).length === 0) return;
            setSetNotes((prev) => {
              const next = { ...fresh, ...prev }; // local unsynced edits win
              cacheSet(cacheKeys.sessionSetNotes(a.id), next).catch(
                (e: unknown) => reportError(e, "cache set notes"),
              );
              return next;
            });
          })
          .catch(() => undefined);
      } catch (e) {
        reportError(e, "load session");
        // The merge never ran, so `setsRef` is empty and untrustworthy. The
        // screen still stops loading — a spinner that never resolves helps
        // nobody, and Finish, notes and navigation all still work — but LOG
        // stays disabled until a reload reads the cache successfully.
        if (!cancelled) setSetsFailed(true);
      } finally {
        if (!cancelled) setSetsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySets]);

  useEffect(() => {
    if (active === null) navigate("/", { replace: true });
  }, [active, navigate]);

  // Mirror the rest clock to the cache. Called at every point that MOVES the
  // clock or the strip, deliberately NOT from an effect keyed on `rest`: the
  // clock lives in `restRef`, and with auto-start rest off, logging a set
  // moves the ref without touching `rest` at all. An effect never ran, the
  // cache kept an OLDER startedAt, and after a reload or an iOS eviction the
  // ref rehydrated from it — so the next set recorded the rest measured from
  // the set before last, silently swallowing a whole set's rest.
  // `rest_seconds_actual` is append-only and that number can never be
  // corrected, so the write belongs where the clock actually moves.
  //
  // `startedAt` always comes from `restRef` (the clock that MEASURES); the
  // target and label describe the STRIP, which can be dismissed or never
  // shown while the clock keeps running — that is what targetSeconds null
  // means, and rehydrate reads it back the same way.
  const mirrorRest = useCallback(
    (targetSeconds: number | null, forLabel: string | null) => {
      const startedAt = restRef.current?.startedAt;
      if (!sessionId || startedAt === undefined) return;
      const snapshot: RestCache = { startedAt, targetSeconds, forLabel };
      cacheSet(cacheKeys.sessionRest(sessionId), snapshot).catch((e: unknown) =>
        reportError(e, "cache rest clock"),
      );
    },
    [sessionId],
  );

  // ---- exercise entries ----------------------------------------------------

  const knownRxIds = useMemo(() => new Set(rx.map((r) => r.id)), [rx]);

  // ramps collapsed, extras appended, orphan sets given a home — see
  // lib/entries.ts, where the rules are pure and unit-tested
  const entries: ExerciseEntry[] = useMemo(
    () => buildEntries(rx, extras, sets, allExercises, subs),
    [rx, extras, sets, allExercises, subs],
  );

  const openEntry = useMemo(
    () => entries.find((e) => e.key === openKey) ?? null,
    [entries, openKey],
  );

  const setsForExercise = useCallback(
    (exerciseId: string) => sets.filter((s) => s.exercise_id === exerciseId),
    [sets],
  );

  const setsForEntry = useCallback(
    (entry: ExerciseEntry) => setsForEntryOf(entry, sets, rx, knownRxIds),
    [sets, rx, knownRxIds],
  );

  /** Working sets logged against an entry — the number that answers "am I
   *  done with this exercise". Everything that is not a WARMUP counts,
   *  which is the same line `workingSets` draws over the brackets: legacy
   *  `backoff` rows are work you were asked to do, and counting them on one
   *  side of that comparison but not the other is how a target becomes
   *  unreachable. */
  const workingCount = useCallback(
    (entry: ExerciseEntry) =>
      setsForEntry(entry).filter((s) => s.set_type !== "warmup").length,
    [setsForEntry],
  );

  /** warmup sets logged against an entry. Counted SEPARATELY, against the
   *  entry's warmup brackets: the coach's "1×12 @ 10 warmup" is a thing to
   *  finish, not a set of the 3×8 that follows it. */
  const warmupCount = useCallback(
    (entry: ExerciseEntry) =>
      setsForEntry(entry).filter((s) => s.set_type === "warmup").length,
    [setsForEntry],
  );

  /** How far through its plan an entry is, and what it is measured against.
   *  Both come from lib/entries so the target and the progress can never be
   *  counted by two different rules — see `targetSets`. */
  const entryProgress = useCallback(
    (e: ExerciseEntry) => progressSets(e, setsForEntry(e)),
    [setsForEntry],
  );

  const entryDone = useCallback(
    (e: ExerciseEntry): boolean =>
      skips.has(e.key) || entryMet(e, setsForEntry(e)),
    [skips, setsForEntry],
  );
  const doneEntries = entries.filter(entryDone).length;

  // default open: first incomplete entry, once, AFTER sets have merged —
  // otherwise a mid-workout reload opens exercise 1 instead of where the
  // user actually is
  const defaultOpened = useRef(false);
  useEffect(() => {
    if (!setsLoaded || defaultOpened.current || entries.length === 0) return;
    defaultOpened.current = true;
    setOpenKey(entries.find((e) => !entryDone(e))?.key ?? null);
  }, [setsLoaded, entries, entryDone]);

  // superset grouping: consecutive entries sharing a non-null group get
  // A1/A2 tags and a bracket rail
  const supersetInfo = useMemo(() => supersetInfoOf(entries), [entries]);

  /** Does this day have any named part? If not, it needs no headings at all. */
  const hasSections = useMemo(
    () => entries.some((e) => (e.brackets[0]?.section ?? null) !== null),
    [entries],
  );

  /**
   * What the plan editor knows about this day, offered to the mid-session add
   * sheet so the two screens answer the same question the same way.
   *
   * Adding a warmup during a workout used to offer only the generic defaults
   * (Activations / Abs / Cooldown), so an exercise added on the gym floor
   * could not join a section the coach had actually written — you had to
   * retype its name exactly, or it landed in the main body and the day's
   * shape quietly diverged from the plan. Anything you can do while planning
   * should be doable while training; this is that, for sections and supersets.
   */
  const knownSections = useMemo(() => {
    const seen: string[] = [];
    const add = (raw: string | null | undefined) => {
      const v = (raw ?? "").trim();
      if (v !== "" && !seen.includes(v)) seen.push(v);
    };
    // plan order, so the chips read in the order the day is actually done
    for (const r of rx) add(r.section);
    for (const e of extras) for (const g of e.scheme ?? []) add(g.section);
    return seen;
  }, [rx, extras]);

  /** group number -> who is already in it, so picking "A" can say what it
   *  pairs with instead of leaving the letter to mean nothing */
  const supersetMembers = useMemo(() => {
    const out: Record<number, string[]> = {};
    for (const r of rx) {
      const g = r.superset_group;
      if (g == null || g < 1) continue;
      const name = r.exercise_name;
      out[g] ??= [];
      if (!out[g].includes(name)) out[g].push(name);
    }
    return out;
  }, [rx]);

  // "NEXT ▸" hint once the open exercise is complete — suggestion, not
  // auto-advance
  const nextEntry = useMemo(() => {
    if (!openEntry || !entryDone(openEntry)) return null;
    const idx = entries.findIndex((e) => e.key === openEntry.key);
    return entries.slice(idx + 1).find((e) => !entryDone(e)) ?? null;
  }, [openEntry, entries, entryDone]);

  // Mid-superset the round, not the list, is what comes next: after A1 you
  // do A2, and `nextEntry` above never helps because it only appears once
  // the OPEN entry is finished, which mid-round it never is. So every log in
  // a superset offered nothing, and the lifter scrolled back up and tapped
  // the partner by hand — every round, of every superset, of every session.
  const partnerEntry = useMemo(
    () => supersetPartnerOf(entries, openKey, entryDone),
    [entries, openKey, entryDone],
  );

  // The partner leads while the round is unfinished; once it is, the
  // ordinary next-exercise hint takes over. Exactly one destination, so the
  // secondary button never has to be read twice.
  const advanceTo = partnerEntry ?? nextEntry;

  const equipment = openEntry
    ? (equipMap[openEntry.exercise_id] ?? null)
    : null;
  const plateable = equipment === "barbell" || equipment === "machine";
  // per-exercise bar (0 = plate-loaded, e.g. leg press); persisted choice
  const exerciseBarKg = useExerciseBarKg(
    openEntry?.exercise_id ?? null,
    unit,
    equipment,
  );
  const exercisePref = useExercisePref(openEntry?.exercise_id ?? null);

  // ---- accordion -----------------------------------------------------------

  const toggleOpen = (key: string) => {
    // a half-made correction does not follow you to another exercise
    if (editing) cancelCorrection();
    setOpenKey((prev) => (prev === key ? null : key));
  };

  useEffect(() => {
    if (!openKey) return;
    // the CSS prefers-reduced-motion block cannot reach the scroll APIs
    itemRefs.current.get(openKey)?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  }, [openKey]);

  // ---- prefill on entry open / bracket advance -----------------------------

  // Which run the set being staged belongs to. The toggle is the lifter's
  // statement of intent — tapping WARMUP means this set is a warmup — and it
  // decides which brackets are walked and therefore which target, load and
  // rep range are shown.
  const stagedKind: BracketKind = setType === "warmup" ? "warmup" : "working";

  /** The kind the NEXT set should be, from what has been LOGGED alone: a
   *  prescribed warmup that is still outstanding, otherwise working. Free of
   *  the toggle on purpose, so it can decide what the toggle starts at. */
  const suggestedKind = useCallback(
    (entry: ExerciseEntry): BracketKind =>
      warmupCount(entry) < warmupSets(entry) ? "warmup" : "working",
    [warmupCount],
  );

  const countFor = useCallback(
    (entry: ExerciseEntry, kind: BracketKind) =>
      kind === "warmup" ? warmupCount(entry) : workingCount(entry),
    [warmupCount, workingCount],
  );

  // the bracket the NEXT set of the staged kind falls into; walking into a
  // new bracket re-prefills (its rep range, its load if set) mid-exercise
  const currentBracket = openEntry
    ? bracketFor(openEntry, countFor(openEntry, stagedKind), stagedKind)
    : null;
  // The bracket a freshly opened exercise should start on, which is a
  // question about the PLAN and not about whatever the toggle was left on
  // two exercises ago.
  const openingKind = openEntry ? suggestedKind(openEntry) : "working";
  const openingBracket = openEntry
    ? bracketFor(openEntry, countFor(openEntry, openingKind), openingKind)
    : null;
  // The kind is part of the key: toggling WARMUP on a day whose plan has no
  // warmup bracket lands on the same bracket, and the lifter should still
  // get that bracket's numbers back rather than a stale staged load.
  //
  // So is the exercise, which is otherwise fixed for an entry and is not once
  // a swap can change it: the bracket and the key both stay put through a
  // substitution, so without this the dumbbell work would sit there staged
  // with the cable's prescribed load.
  const prefillKey = openEntry
    ? `${openEntry.key}:${openEntry.exercise_id}:${currentBracket?.id ?? "free"}:${stagedKind}`
    : null;

  /** Is this slot being performed with a movement the plan did not name? */
  const swapped = openEntry?.substitutedFor !== undefined;

  // ---- per-side convention -------------------------------------------------

  // How this movement's load is expressed: the user's own choice, then the
  // coach's prescription, then a guess from the equipment (lib/loadEntry.ts).
  // `entryKg` is one side when this is "per_side"; `totalLoadKg` is what the
  // database always stores.
  const loadEntryInput = {
    override: exercisePref.loadEntry,
    // The coach's convention describes the movement the coach named. A cable
    // stack is a total; the pair of dumbbells standing in for it is not, and
    // inheriting "total" from the prescription would store one hand's weight
    // as the whole system load. Dropped on a swap so the chain falls through
    // to this exercise's own equipment, which is what actually got lifted.
    prescribed: swapped ? null : (currentBracket?.load_entry ?? null),
    equipment,
    name: openEntry?.name ?? "",
  };
  const loadEntry: LoadEntry = resolveLoadEntry(loadEntryInput);
  const perSide = loadEntry === "per_side";
  const showLoadEntry = openEntry !== null && offersLoadEntry(loadEntryInput);
  const totalLoadKg = totalKg(entryKg, loadEntry);
  // the total is what the column caps, so a per-side entry caps at half
  const maxEntryKg = perSide ? MAX_LOAD_KG / 2 : MAX_LOAD_KG;

  /** Flip the convention for this exercise, persisted device-locally beside
   *  its bar and increment. The number on screen deliberately does NOT move:
   *  it is what is written on the implement, and only the count of implements
   *  changed. */
  const toggleLoadEntry = () => {
    if (!openEntry) return;
    setExerciseLoadEntry(openEntry.exercise_id, perSide ? "total" : "per_side");
  };

  // rest before the next set: the coach's bracket, then this movement's own
  // preference, then the global default
  const restSeconds = useExerciseRestSeconds(
    openEntry?.exercise_id ?? null,
    currentBracket?.rest_seconds ?? null,
  );

  const prefilledFor = useRef<string | null>(null);
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    // wait for the sets merge: a mid-workout reload otherwise prefills from
    // the wrong bracket and can clobber staged values while a sheet is open
    if (!setsLoaded || !openEntry || prefillKey === null) return;
    // Opening an exercise is the one moment the TYPE is decided for you: the
    // plan's outstanding warmup, if it has one. This used to be a flat
    // `setSetType("working")` on every prefill, and logSet reset to working
    // after every log, so a prescribed warmup could only be logged by
    // remembering to tap WARMUP for each one — and tapping it then left the
    // counter stuck, because the same set was counted against the working
    // target. Half a wired feature is worse than none: the honest way to
    // finish the day was to log the warmup as working, at the warmup weight.
    const fresh = openedFor.current !== openEntry.key;
    const bracket = fresh ? openingBracket : currentBracket;
    const key = fresh
      ? `${openEntry.key}:${bracket?.id ?? "free"}:${openingKind}`
      : prefillKey;
    if (!fresh && prefilledFor.current === key) return;
    openedFor.current = openEntry.key;
    prefilledFor.current = key;
    const logged = setsForExercise(openEntry.exercise_id);
    const lastThis = logged[logged.length - 1];
    const p = prefillSet({
      prescription: bracket
        ? {
            // A substitution keeps the coach's REPS and loses the coach's
            // LOAD. The rep target is a training instruction and survives the
            // movement change — 3×8 is still 3×8 — but 25 kg on a cable stack
            // is not 25 kg of dumbbell, and prefilling it would hand the
            // lifter a number from a machine they are not standing at. Nulled
            // here, so the chain falls through to this movement's own last
            // set and then to its last session (`lastActuals` is keyed by
            // exercise, and the entry now names the chosen one).
            resolved_load_kg: swapped ? null : bracket.resolved_load_kg,
            // plate_load_kg rounds the TOTAL to 2.5 kg, which is the wrong
            // granularity for a pair (2.5 kg per hand is a 5 kg step), so a
            // per-side movement prefills from the unrounded resolved load —
            // see the migration header.
            plate_load_kg: perSide || swapped ? null : bracket.plate_load_kg,
            reps_min: bracket.reps_min,
            reps_max: bracket.reps_max,
          }
        : null,
      lastThisSession: lastThis
        ? { load_kg: lastThis.load_kg, reps: lastThis.reps }
        : null,
      lastSession: lastActuals[openEntry.exercise_id] ?? null,
    });
    // every source above is a TOTAL; the steppers hold what gets typed
    setEntryKg(Math.round(enteredKg(p.loadKg, loadEntry) * 100) / 100);
    setReps(p.reps);
    // Only on a fresh open. After that the toggle belongs to the lifter (and
    // to logSet, which advances it as the plan's warmups are used up):
    // writing it here on every bracket change would fight a deliberate tap.
    if (fresh) setSetType(openingKind);
    // `loadEntry`/`perSide` are deliberately NOT dependencies: flipping the
    // convention mid-entry must not re-prefill over a staged value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    setsLoaded,
    openEntry,
    prefillKey,
    currentBracket,
    openingBracket,
    openingKind,
    setsForExercise,
    lastActuals,
  ]);

  // ---- rest helpers --------------------------------------------------------

  const restElapsedSeconds = (): number | null => {
    if (!restRef.current) return null;
    return (Date.now() - restRef.current.startedAt) / 1000;
  };

  const recordableRest = (): number | null => {
    const el = restElapsedSeconds();
    if (el === null || el > MAX_REST_SECONDS) return null;
    return Math.max(0, Math.round(el));
  };

  // ---- actions -------------------------------------------------------------

  const logSet = () => {
    // FIRST, and before every guard below: iOS only lets an AudioContext start
    // inside a user gesture, and this tap is the gesture that starts the rest
    // the cue will end. Running it ahead of the early returns keeps it tied to
    // the tap rather than to whether the tap turned into a set — a locked-out
    // double tap is still a gesture, and the unlock is idempotent. Deliberately
    // NOT gated on the rest-sound preference: someone who turns the tone on
    // mid-workout should hear the very next rest end, not the one after it.
    unlockRestCue();

    // setsFailed: see the state declaration — an empty `setsRef` we could not
    // verify would number this set 0 on top of whatever is already logged.
    if (!openEntry || !sessionId || logLocked || !setsLoaded || setsFailed)
      return;
    setLogLocked(true);
    window.setTimeout(() => setLogLocked(false), LOG_LOCK_MS);
    setVoidArm(null);
    // logging on a skipped exercise means it's happening after all
    if (skips.has(openEntry.key)) {
      const unskipped = new Set(skips);
      unskipped.delete(openEntry.key);
      persistSkips(unskipped);
    }

    const nextIndex =
      setsRef.current
        .filter((s) => s.exercise_id === openEntry.exercise_id)
        .reduce((m, s) => Math.max(m, s.set_index), -1) + 1;
    const set: SetInsert = {
      id: uuid(),
      session_id: sessionId,
      // The movement ACTUALLY PERFORMED. On a substituted entry that is the
      // exercise the lifter swapped in, not the one the plan named — which is
      // the whole point: History, e1RM and volume must describe what was
      // lifted. The prescription link below is unaffected by that and stays
      // the planned bracket; the two halves are deliberately different
      // questions ("what did you do" vs "which slot was it"), and collapsing
      // them into one is the mistake this comment exists to prevent. See
      // `ExerciseEntry.substitutedFor`.
      exercise_id: openEntry.exercise_id,
      // the set links to the BRACKET it fulfills, so adherence analytics see
      // the coach's actual scheme (warmups link to the upcoming bracket).
      // A LOCALLY declared bracket is not a prescription row — it exists only
      // in this device's cache — and prescription_id is a foreign key, so it
      // must go in as null or the insert fails and the offline queue retries
      // it forever.
      prescription_id: isLocalBracket(currentBracket?.id)
        ? null
        : (currentBracket?.id ?? null),
      set_index: nextIndex,
      set_type: setType,
      // A tick is a real row in `sets`: 0 reps at 0 load, both already legal.
      // The alternative is a second kind of completion record that no view, no
      // chart and no MCP tool knows how to read — and volume and e1RM already
      // ignore it, through the filters they have always had rather than a new
      // coupling to the plan.
      // ALWAYS the total system load; load_entry records how it was typed
      load_kg: isTick(openEntry) ? 0 : Math.round(totalLoadKg * 100) / 100,
      reps: isTick(openEntry) ? 0 : reps,
      performed_at: new Date().toISOString(),
      rest_seconds_actual: recordableRest(),
      load_entry: loadEntryForSet(loadEntry, totalLoadKg),
    };
    const next = applySets((prev) => [...prev, set]);
    cacheSet(cacheKeys.sessionSets(sessionId), next).catch((e: unknown) =>
      reportError(e, "cache session sets"),
    );
    outbox
      .enqueue({ kind: "insert", table: "sets", payload: set })
      .catch((e: unknown) => reportError(e, "log set"));

    // Done-ness read from the list that now INCLUDES this set: `sets` state
    // is a render behind, and both decisions below are about the workout as
    // it stands after the tap.
    const doneAfter = (e: ExerciseEntry): boolean =>
      // logging on a skipped exercise un-skips it (above), so the open entry
      // is never treated as skipped here
      (skips.has(e.key) && e.key !== openEntry.key) ||
      entryMet(e, setsForEntryOf(e, next, rx, knownRxIds));
    // Mid-superset the rest strip is a countdown to nothing: the next thing
    // to do is the partner, not a wait. Only the STRIP is held — the clock
    // below always starts, because `rest_seconds_actual` is data and
    // append-only, so a rest not measured now can never be recorded later.
    const roundOpen = supersetPartnerOf(entries, openEntry.key, doneAfter);

    // The clock always starts MEASURING (rest_seconds_actual is data, and
    // append-only means it can never be added later); auto-start governs only
    // whether the strip appears.
    const now = Date.now();
    restRef.current = { startedAt: now };
    const forLabel = `${openEntry.name} set ${nextIndex + 1}`;
    const showStrip = autoStartRest && roundOpen === null;
    if (showStrip)
      setRest({ startedAt: now, targetSeconds: restSeconds, forLabel });
    // Mirror the clock HERE, whether or not a strip appeared. With auto-start
    // off nothing about `rest` changes, so nothing else would ever write the
    // new startedAt — and no strip also means there is none to restore, which
    // is the null target.
    mirrorRest(showStrip ? restSeconds : null, showStrip ? forLabel : null);
    // What the NEXT set should be, from the plan rather than from a reset:
    // this was an unconditional "working", so a coach's second prescribed
    // warmup arrived pre-set to working and got logged as one.
    const warmupsLogged = setsForEntryOf(
      openEntry,
      next,
      rx,
      knownRxIds,
    ).filter((s) => s.set_type === "warmup").length;
    setSetType(warmupsLogged < warmupSets(openEntry) ? "warmup" : "working");
  };

  const openSheet = (kind: "search" | "swap" | "plates") => {
    setSheet(kind);
    setPad(null);
    // Which door was opened is recorded HERE rather than at each call site, so
    // the create-exercise sheet behind the picker can never send a substitute
    // to the end of the list because somebody forgot to say so.
    if (kind === "search") setPicking("add");
    if (kind === "swap") setPicking("swap");
  };

  const openPad = (kind: PadKind, fromPlates = false) => {
    setPad({ kind, fromPlates });
    setSheet(null);
  };

  /**
   * Picking an exercise mid-session opens the same scheme sheet the plan
   * editor uses: how many sets, what each weighs, which are warmups. Declaring
   * it up front is what turns "LOG SET 3" into "LOG SET 3 OF 5" for something
   * the plan never mentioned — the screen counts down against the declaration
   * exactly as it does against a coach's.
   */
  const addExercise = (ex: ExerciseRow) => {
    if (!sessionId) return;
    const existing = entries.find((e) => e.exercise_id === ex.id);
    if (existing) {
      setOpenKey(existing.key);
      setSheet(null);
      return;
    }
    setSheet(null);
    setDeclaring(ex);
  };

  const saveDeclared = async (ex: ExerciseRow, groups: SetGroup[]) => {
    if (!sessionId) return;
    const nextExtras: ExtraExercise[] = [
      ...extras,
      { exercise_id: ex.id, name: ex.name, scheme: groups },
    ];
    setExtras(nextExtras);
    await cacheSet(cacheKeys.sessionExtras(sessionId), nextExtras);
    setDeclaring(null);
    setOpenKey(`extra:${ex.id}`);
  };

  // ---- corrections ---------------------------------------------------------

  /** Tap a logged set: its numbers move into the steppers, LOG becomes
   *  SAVE SET N. The old row is untouched until Save. */
  const startCorrection = (s: SetInsert) => {
    if (editing?.set.id === s.id) return;
    setVoidArm(null);
    setNoteEditingId(null);
    // Only the first tap displaces the staged values; re-tapping a different
    // set mid-correction must still restore what was there BEFORE editing.
    const staged = editing?.staged ?? { entryKg, reps, setType };
    setEditing({ set: s, staged });
    // load_kg is the TOTAL; show it in whatever convention the exercise is
    // in NOW, so Save — which totals the entry by that same convention —
    // round-trips exactly even if the toggle was flipped since the set.
    setEntryKg(Math.round(enteredKg(s.load_kg, loadEntry) * 100) / 100);
    setReps(s.reps);
    setSetType(s.set_type);
  };

  const cancelCorrection = () => {
    if (!editing) return;
    setEntryKg(editing.staged.entryKg);
    setReps(editing.staged.reps);
    setSetType(editing.staged.setType);
    setEditing(null);
  };

  /** Void the old row and append its replacement at the same set_index.
   *  Nothing about WHEN the set happened changes: performed_at, the rest
   *  before it and the rest clock after it all stand. */
  const saveCorrection = () => {
    if (!editing || !sessionId || logLocked) return;
    const old = editing.set;
    const correction = {
      load_kg: Math.round(totalLoadKg * 100) / 100,
      reps,
      set_type: setType,
      load_entry: loadEntryForSet(loadEntry, totalLoadKg),
    };
    if (isNoopCorrection(old, correction)) {
      cancelCorrection();
      return;
    }
    setLogLocked(true);
    window.setTimeout(() => setLogLocked(false), LOG_LOCK_MS);
    const next = correctedSet(old, correction);

    const nextVoids = new Set(voids);
    nextVoids.add(old.id);
    setVoids(nextVoids);
    cacheSet(cacheKeys.sessionVoids(sessionId), [...nextVoids]).catch(
      (e: unknown) => reportError(e, "cache voids"),
    );
    const nextSets = applySets((prev) =>
      prev.map((x) => (x.id === old.id ? next : x)),
    );
    cacheSet(cacheKeys.sessionSets(sessionId), nextSets).catch((e: unknown) =>
      reportError(e, "cache session sets"),
    );
    // Insert BEFORE void. If the queue dies between the two, the log holds a
    // duplicate set rather than a missing one — and a duplicate is visible,
    // so it gets fixed.
    outbox
      .enqueue({ kind: "insert", table: "sets", payload: next })
      .then(() =>
        outbox.enqueue({
          kind: "insert",
          table: "set_voids",
          payload: { set_id: old.id },
        }),
      )
      .catch((e: unknown) => reportError(e, "correct set"));
    // the note is about the set, and the set now has a new id
    const note = setNotes[old.id];
    if (note) {
      const nextNotes = { ...setNotes, [next.id]: note };
      setSetNotes(nextNotes);
      cacheSet(cacheKeys.sessionSetNotes(sessionId), nextNotes).catch(
        (e: unknown) => reportError(e, "cache set notes"),
      );
      outbox
        .enqueue({
          kind: "insert",
          table: "set_notes",
          payload: { set_id: next.id, note },
        })
        .catch((e: unknown) => reportError(e, "carry set note"));
    }

    setEntryKg(editing.staged.entryKg);
    setReps(editing.staged.reps);
    setSetType(editing.staged.setType);
    setEditing(null);
    toast(`Set ${old.set_index + 1} corrected`);
  };

  /** Void a logged set: hide it from every view via an append-only
   *  set_voids insert. The row itself is never edited or deleted. */
  const voidSet = (s: SetInsert) => {
    if (!sessionId) return;
    setVoidArm(null);
    if (editing?.set.id === s.id) cancelCorrection();
    // voiding the set that started the current rest cancels the clock —
    // the rest was being measured from a set that no longer counts
    const startedClock = setsRef.current.every(
      (x) => x.id === s.id || x.performed_at <= s.performed_at,
    );
    if (startedClock && restRef.current) {
      restRef.current = null;
      setRest(null);
      // Drop the mirror directly, for the same reason logSet writes it
      // directly: a stale startedAt here would be rehydrated as this void's
      // rest and recorded on the next set.
      cacheDelete(cacheKeys.sessionRest(sessionId)).catch((e: unknown) =>
        reportError(e, "clear rest clock"),
      );
    }
    const nextVoids = new Set(voids);
    nextVoids.add(s.id);
    setVoids(nextVoids);
    cacheSet(cacheKeys.sessionVoids(sessionId), [...nextVoids]).catch(
      (e: unknown) => reportError(e, "cache voids"),
    );
    const next = applySets((prev) => prev.filter((x) => x.id !== s.id));
    cacheSet(cacheKeys.sessionSets(sessionId), next).catch((e: unknown) =>
      reportError(e, "cache session sets"),
    );
    outbox
      .enqueue({
        kind: "insert",
        table: "set_voids",
        payload: { set_id: s.id },
      })
      .catch((e: unknown) => reportError(e, "remove set"));
    toast(`Set ${s.set_index + 1} removed`);
  };

  const persistSkips = (next: Set<string>) => {
    setSkips(next);
    if (sessionId)
      cacheSet(cacheKeys.sessionSkips(sessionId), [...next]).catch(
        (e: unknown) => reportError(e, "cache skips"),
      );
  };

  const toggleSkip = (entry: ExerciseEntry) => {
    const next = new Set(skips);
    if (next.has(entry.key)) next.delete(entry.key);
    else next.add(entry.key);
    persistSkips(next);
  };

  /** Extras with no logged sets can be removed outright (session-local). */
  const removeExtra = async (entry: ExerciseEntry) => {
    if (!sessionId || entry.brackets.length > 0) return;
    // The PLANNED id: `extras` is what was added, and a swap does not rewrite
    // it any more than it rewrites a prescription. Matching on the performed
    // exercise would quietly remove nothing at all.
    const nextExtras = extras.filter(
      (e) => e.exercise_id !== plannedExerciseId(entry),
    );
    setExtras(nextExtras);
    await cacheSet(cacheKeys.sessionExtras(sessionId), nextExtras);
    // drop any lingering skip so re-adding doesn't arrive pre-skipped
    if (skips.has(entry.key)) {
      const nextSkips = new Set(skips);
      nextSkips.delete(entry.key);
      persistSkips(nextSkips);
    }
    // and any lingering swap, for the same reason: the entry key is derived
    // from the exercise, so re-adding it would inherit the old substitution
    if (subs[entry.key]) {
      const nextSubs = { ...subs };
      delete nextSubs[entry.key];
      persistSubs(nextSubs);
    }
    if (openKey === entry.key) setOpenKey(null);
  };

  // ---- substitutions -------------------------------------------------------
  // The cable station is taken, so the tricep extension happens with a
  // dumbbell. Before this the only options were to log the dumbbell work under
  // the cable's name — a false record, permanently, because `sets` is
  // append-only — or to write it in prose that no view, chart or MCP tool can
  // read. A real user did the second: "Had to switch tricep cable with
  // dumbbell overhead extension".

  const persistSubs = (next: Substitutions) => {
    setSubs(next);
    if (sessionId)
      cacheSet(cacheKeys.sessionSwaps(sessionId), next).catch((e: unknown) =>
        reportError(e, "cache substitutions"),
      );
  };

  /** Sets logged against the SWAP itself — the ones that already name the
   *  chosen exercise. Sets logged before the swap name the planned one and
   *  are not these. */
  const swappedSets = useCallback(
    (entry: ExerciseEntry) =>
      entry.substitutedFor === undefined
        ? []
        : setsForEntry(entry).filter(
            (s) => s.exercise_id === entry.exercise_id,
          ),
    [setsForEntry],
  );

  /**
   * A swap is frozen once something has been logged against it.
   *
   * Those sets are append-only and already name the chosen exercise: undoing
   * would leave the entry claiming to be the planned movement while the rows
   * under it say otherwise, and nothing can rewrite them. Before the first
   * such set the swap is pure intent, so it is freely undone and freely
   * changed again.
   */
  const swapFrozen = useCallback(
    (entry: ExerciseEntry) => swappedSets(entry).length > 0,
    [swappedSets],
  );

  /** Perform this slot with a different movement. Picking the planned
   *  exercise back is the undo — one door in, the same door out. */
  const swapExercise = (entry: ExerciseEntry, ex: ExerciseRow) => {
    if (!sessionId || swapFrozen(entry)) return;
    const plannedId = plannedExerciseId(entry);
    const plannedName = entry.substitutedFor?.name ?? entry.name;
    const next = { ...subs };
    if (ex.id === plannedId) delete next[entry.key];
    else
      next[entry.key] = {
        exercise_id: ex.id,
        name: ex.name,
        planned_exercise_id: plannedId,
        planned_name: plannedName,
      };
    persistSubs(next);
    setSheet(null);
  };

  const undoSwap = (entry: ExerciseEntry) => {
    if (!sessionId || swapFrozen(entry)) return;
    const next = { ...subs };
    delete next[entry.key];
    persistSubs(next);
  };

  /** An exercise chosen from a picker, or created because the library lacked
   *  it: it either joins the day or takes over the open entry's movement,
   *  depending on which picker was opened. */
  const pickedExercise = (ex: ExerciseRow) => {
    if (picking === "swap" && openEntry) swapExercise(openEntry, ex);
    else addExercise(ex);
  };

  // ---- per-set notes -------------------------------------------------------

  const openNote = (setId: string) => {
    setNoteEditingId(setId);
    setNoteDraft(setNotes[setId] ?? "");
  };

  const saveNote = (setId: string) => {
    if (!sessionId) return;
    const note = noteDraft.trim();
    const next = { ...setNotes, [setId]: note };
    setSetNotes(next);
    setNoteEditingId(null);
    cacheSet(cacheKeys.sessionSetNotes(sessionId), next).catch((e: unknown) =>
      reportError(e, "cache set notes"),
    );
    outbox
      .enqueue({
        kind: "insert",
        table: "set_notes",
        payload: { set_id: setId, note },
      })
      .catch((e: unknown) => reportError(e, "save set note"));
  };

  // ---- pad request ---------------------------------------------------------

  const padRequest = (): PadRequest | null => {
    if (!pad || !openEntry) return null;
    const U = unit.toUpperCase();
    if (pad.kind === "load") {
      return {
        label: `${openEntry.name.toUpperCase()} · LOAD IN ${U}${
          perSide ? " PER SIDE" : ""
        }`,
        action: pad.fromPlates ? "BACK TO PLATES" : "SET LOAD",
        initial: String(toDisplay(entryKg, unit)),
        allowDecimal: true,
        onCommit: (v) => {
          const kg = Math.min(maxEntryKg, Math.max(0, fromDisplay(v, unit)));
          setEntryKg(Math.round(kg * 100) / 100);
          setPad(null);
          if (pad.fromPlates) setSheet("plates");
        },
        onCancel: () => {
          setPad(null);
          if (pad.fromPlates) setSheet("plates");
        },
      };
    }
    if (pad.kind === "reps") {
      return {
        label: `${openEntry.name.toUpperCase()} · REPS`,
        action: "SET REPS",
        initial: String(reps),
        allowDecimal: false,
        onCommit: (v) => {
          setReps(Math.min(MAX_REPS, Math.max(0, Math.round(v))));
          setPad(null);
        },
        onCancel: () => setPad(null),
      };
    }
    // rest: type the seconds REMAINING; target = elapsed + typed
    const el = restElapsedSeconds() ?? 0;
    const remaining = rest
      ? Math.max(0, Math.round(rest.targetSeconds - el))
      : 0;
    return {
      label: "REST · SECONDS REMAINING",
      action: "SET REST",
      initial: String(remaining),
      allowDecimal: false,
      onCommit: (v) => {
        const want = Math.min(MAX_REST_SECONDS, Math.max(0, Math.round(v)));
        // elapsed re-read at commit time so typing delay doesn't skew it
        const nowEl = Math.round(restElapsedSeconds() ?? 0);
        if (rest) {
          setRest({ ...rest, targetSeconds: nowEl + want });
          mirrorRest(nowEl + want, rest.forLabel);
        }
        setPad(null);
      },
      onCancel: () => setPad(null),
    };
  };

  // ---- render --------------------------------------------------------------

  if (active === undefined) return <div className="screen muted">Loading…</div>;
  if (!active) return null;

  const entrySets = openEntry ? setsForEntry(openEntry) : [];
  // The set just logged — the only one whose note affordance is spelled out.
  // The clock breaks the tie, because a swapped entry holds two runs of
  // set_index, each counting from 0 (the index is scoped per exercise).
  const newestSetId =
    entrySets.length === 0
      ? null
      : entrySets.reduce((a, b) =>
          b.set_index > a.set_index ||
          (b.set_index === a.set_index && b.performed_at > a.performed_at)
            ? b
            : a,
        ).id;

  // plate maths is always about the whole loaded implement
  const hint = plateable
    ? (() => {
        const r = split(totalLoadKg, exerciseBarKg, inventory);
        return r.plates.length > 0
          ? r.plates
              .map(
                (p) =>
                  `${p.count > 1 ? `${p.count}×` : ""}${formatPlate(p.plate, unit)}`,
              )
              .join("·")
          : exerciseBarKg > 0
            ? "BAR ONLY"
            : "EMPTY";
      })()
    : null;

  // per side, the arithmetic the app is doing on the user's behalf is the
  // thing worth showing; otherwise the converted twin
  const loadSub = perSide
    ? `${toDisplay(totalLoadKg, unit)} ${unit} total`
    : formatStoredTwin(entryKg, unit);

  /**
   * "Last time · 60 kg × 8, 8, 6" — the previous SESSION's working sets for
   * this movement, in the convention the screen is currently using.
   *
   * The run, not one set. A single "60 kg × 8" is the top of a shape and
   * says nothing about whether the last set of it was a grind: what a lifter
   * standing at the rack is deciding is whether to repeat the day or add
   * weight, and the reps that fell away are the whole of that answer. When
   * the load moved across the run each set is quoted with its own, because
   * "60, 65, 70 × 8, 8, 6" would be a puzzle rather than a reminder.
   *
   * Reference text: it never competes with the target or the log button.
   */
  const lastTime = (exerciseId: string): string | null => {
    const a = lastActuals[exerciseId];
    if (!a) return null;
    const shown = (kg: number) =>
      `${toDisplay(enteredKg(kg, loadEntry), unit)} ${unit}${perSide ? "/side" : ""}`;
    // a value cached before runs existed carries only the top set
    const run = a.run && a.run.length > 0 ? a.run : [a];
    const sameLoad = run.every((s) => s.load_kg === run[0].load_kg);
    const body = sameLoad
      ? `${shown(run[0].load_kg)} × ${run.map((s) => s.reps).join(", ")}`
      : run.map((s) => `${shown(s.load_kg)} × ${s.reps}`).join(" · ");
    return `Last time · ${body}`;
  };

  /** rest AFTER a given set: next exercise-set's stored value, or live timer.
   *
   *  Scoped to the set's OWN exercise, not the entry's: set_index counts per
   *  exercise, so a swapped entry holds two runs that both start at 0 and
   *  "the set after this one" must never be read across them. Identical to
   *  the old behaviour when nothing was swapped, where the two are the same
   *  list. The live clock belongs to the newest set of all, for the same
   *  reason: each run has a last set, and only one of them just happened. */
  const restAfter = (s: SetInsert): string | null => {
    const run = setsForExercise(s.exercise_id);
    const nextSet = run.find((x) => x.set_index === s.set_index + 1);
    if (nextSet)
      return nextSet.rest_seconds_actual !== null
        ? `rest ${formatClock(nextSet.rest_seconds_actual)}`
        : null;
    const isLast =
      s.id === newestSetId && run.every((x) => x.set_index <= s.set_index);
    if (isLast && restRef.current) {
      const el = restElapsedSeconds();
      if (el !== null && el <= MAX_REST_SECONDS)
        return `rest ${formatClock(el)}`;
    }
    return null;
  };

  /** "1×8-15 @ 90 KG · 3×3-5" — an entry's full prescribed scheme */
  const scheme = (entry: ExerciseEntry): string =>
    entry.brackets.map((b) => formatRxTarget(b, unit)).join(" · ");

  /** The load stepper's buttons: coarse pair outside, fine pair inside. Both
   *  the label and the delta come from `stepKgFor`, so a per-exercise or
   *  per-unit increment can never disagree with what the button says. The
   *  fine pair is dropped when it would duplicate the coarse one. */
  const loadSteps = (exerciseId: string, u: Unit): StepDef[] => {
    const coarse = stepKgFor(exerciseId, u, false);
    const fine = stepKgFor(exerciseId, u, true);
    const label = (kg: number) => toDisplay(kg, u);
    // `announce` says the step in the unit the lifter reads. Without it the
    // spoken label carried the kg equivalent of a five-pound plate —
    // "increase load by 2.2679618500000003".
    const say = (kg: number) => `${label(kg)} ${u}`;
    const steps: StepDef[] = [
      { label: `− ${label(coarse)}`, delta: -coarse, announce: say(coarse) },
      { label: `+ ${label(coarse)}`, delta: coarse, announce: say(coarse) },
    ];
    if (label(fine) === label(coarse)) return steps;
    return [
      steps[0],
      {
        label: `− ${label(fine)}`,
        delta: -fine,
        fine: true,
        announce: say(fine),
      },
      {
        label: `+ ${label(fine)}`,
        delta: fine,
        fine: true,
        announce: say(fine),
      },
      steps[1],
    ];
  };

  /** A movement logged by ticking it off rather than by weight and reps. */
  const isTick = (entry: ExerciseEntry | null): boolean =>
    entry?.brackets[0]?.tracking === "done";

  /** "LOG WARMUP 1 OF 2", "LOG SET 2 OF 5", or "LOG EXTRA SET" past the plan.
   *  Warmups count against the warmups the coach wrote, working sets against
   *  the working sets — two runs, two targets, never added together. */
  const logLabel = (entry: ExerciseEntry): string => {
    if (!setsLoaded) return "LOADING…";
    if (setsFailed) return "LOG UNAVAILABLE";
    if (isTick(entry)) {
      // a tick has no warmup/working distinction to make; it counts against
      // whatever its plan actually asked for
      const n = entryProgress(entry) + 1;
      const total = targetSets(entry);
      return total > 0 && n <= total ? `DONE ${n} OF ${total}` : "MARK DONE";
    }
    if (setType === "warmup") {
      const n = warmupCount(entry) + 1;
      const total = warmupSets(entry);
      return total > 0 && n <= total
        ? `LOG WARMUP ${n} OF ${total}`
        : "LOG WARMUP SET";
    }
    const n = workingCount(entry) + 1;
    if (entry.brackets.length === 0) return `LOG SET ${n}`;
    const total = workingSets(entry);
    return n > total ? "LOG EXTRA SET" : `LOG SET ${n} OF ${total}`;
  };

  const req = padRequest();
  const sheetOpen = sheet !== null || pad !== null;

  return (
    <div className="session-shell">
      <div
        className="session-scroll"
        style={
          noteEditingId && kbInset > 0 ? { paddingBottom: kbInset } : undefined
        }
      >
        {(active.plan_note || active.coach_note) && (
          <div className="session-notes">
            {active.plan_note && (
              <Note label="PLAN NOTE" text={active.plan_note} />
            )}
            {active.coach_note && (
              <Note label="COACH" text={active.coach_note} />
            )}
          </div>
        )}

        <section className="rule-section">
          <div className="section-head">
            {/* the screen's h1: the workout being logged */}
            <h1 className="field-label">
              {active.workout_label
                ? active.workout_label.toUpperCase()
                : "WORKOUT"}
            </h1>
            {entries.length > 0 && (
              <span className="section-meta">
                {doneEntries} OF {entries.length} DONE
              </span>
            )}
          </div>

          {entries.map((entry, entryIndex) => {
            // The heading the coach wrote — "Activations", "Cooldown" —
            // shown above the first exercise that sits under it, exactly as
            // the plan editor shows it. The session used to render one flat
            // list, so a day the coach had shaped into parts arrived on the
            // gym floor with the shape thrown away.
            //
            // Emitted on CHANGE rather than once per distinct name, which is
            // what the plan editor does too: sections are contiguous by
            // construction there, and if an older plan ever interleaved them,
            // showing the heading again is honest about the order the day is
            // actually in.
            const sectionOf = (e: ExerciseEntry | undefined) =>
              e?.brackets[0]?.section ?? null;
            const section = sectionOf(entry);
            const prevSection = sectionOf(entries[entryIndex - 1]);
            const showSection = section !== null && section !== prevSection;
            // MAIN WORK, on the same rule the plan editor uses: only once the
            // day has a named part somewhere, and above the first exercise of
            // each unsectioned run. A flat day gains no heading at all.
            const showMain =
              section === null &&
              hasSections &&
              (entryIndex === 0 || prevSection !== null);

            const isOpen = entry.key === openKey;
            const prescribed = entry.brackets.length > 0;
            const done = entryProgress(entry);
            // the plan's WORKING sets: a prescribed warmup has its own count
            // on the log button and never inflates the day's target
            const total = prescribed ? targetSets(entry) : null;
            // An unprescribed exercise has no plan to meet, so it never hands
            // the lead over to NEXT — there is always another set you might do.
            const planMet = total !== null && done >= total;
            const skipped = skips.has(entry.key);
            const removable = !prescribed && setsForEntry(entry).length === 0;
            const superset = supersetInfo.get(entry.key);
            return (
              <Fragment key={entry.key}>
                {showSection && (
                  <div className="section-head wk-section-head">
                    <span className="field-label">{section.toUpperCase()}</span>
                  </div>
                )}
                {showMain && (
                  <div className="section-head wk-section-head wk-main-head">
                    <span className="field-label">MAIN WORK</span>
                  </div>
                )}
                <div
                  ref={(el) => {
                    if (el) itemRefs.current.set(entry.key, el);
                    else itemRefs.current.delete(entry.key);
                  }}
                  className={`wk-item ${isOpen ? "wk-item-on" : ""}`}
                >
                  <div className="wk-row">
                    {superset && (
                      <span
                        className={`wk-superset-rail ${superset.first ? "wk-superset-rail-start" : ""} ${superset.last ? "wk-superset-rail-end" : ""}`}
                      >
                        <span className="wk-superset-tag">{superset.tag}</span>
                      </span>
                    )}
                    {isOpen ? (
                      <button
                        type="button"
                        className="wk-header-open"
                        aria-expanded={isOpen}
                        aria-label={`collapse ${entry.name}`}
                        onClick={() => toggleOpen(entry.key)}
                      >
                        {entry.name}{" "}
                        <span className="chev" aria-hidden="true">
                          ▾
                        </span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="wk-main"
                        aria-expanded={isOpen}
                        onClick={() => toggleOpen(entry.key)}
                      >
                        <span
                          className={`wk-name ${skipped ? "wk-name-skipped" : ""}`}
                        >
                          {entry.name}
                        </span>
                        <span className="wk-target">
                          {/* A swapped entry says so on the collapsed row and
                              names what was planned: the row's title is now a
                              movement the coach never wrote, and the lifter
                              has to be able to see that at a glance and put
                              it back. The target beside it is unchanged,
                              because the plan is. */}
                          {entry.substitutedFor && !skipped
                            ? `INSTEAD OF ${entry.substitutedFor.name.toUpperCase()} · `
                            : ""}
                          {skipped
                            ? "SKIPPED"
                            : prescribed
                              ? scheme(entry).toUpperCase()
                              : "NO TARGET · BY FEEL"}
                        </span>
                        <span
                          className={`wk-count ${total !== null && done >= total ? "wk-count-done" : ""}`}
                        >
                          {done}
                          {total !== null ? `/${total}` : ""}
                        </span>
                      </button>
                    )}
                    {!isOpen && (
                      /* UNDO ADD, not REMOVE: this only ever drops an extra you
                       added this session and have not logged into. Two taps
                       like every destructive action. */
                      <button
                        type="button"
                        className={`drawer-action ${
                          removable && dropArm === entry.key
                            ? "drawer-action-armed"
                            : ""
                        }`}
                        onClick={() => {
                          if (!removable) {
                            toggleSkip(entry);
                            return;
                          }
                          if (dropArm === entry.key) {
                            setDropArm(null);
                            void removeExtra(entry);
                          } else {
                            setDropArm(entry.key);
                          }
                        }}
                      >
                        {removable
                          ? dropArm === entry.key
                            ? "UNDO ADD?"
                            : "UNDO ADD"
                          : skipped
                            ? "UNSKIP"
                            : "SKIP"}
                      </button>
                    )}
                  </div>

                  {isOpen && (
                    <div className="wk-open">
                      <span className="rx-context">
                        {prescribed ? (
                          <>
                            TARGET {scheme(entry).toUpperCase()}
                            {entry.brackets.length > 1 && currentBracket
                              ? ` · NOW ${formatRepRange(currentBracket.reps_min, currentBracket.reps_max)} REPS`
                              : ""}
                            {currentBracket?.rest_seconds != null
                              ? ` · REST ${formatClock(currentBracket.rest_seconds)}`
                              : ""}
                            {entry.brackets.some(rxHasNoTm)
                              ? " · NO TM SET"
                              : ""}
                          </>
                        ) : (
                          `NO TARGET · BY FEEL${equipment ? ` · ${equipment.toUpperCase()}` : ""}`
                        )}
                      </span>

                      {/* "Last time" is the CHOSEN movement's own history:
                          `entry.exercise_id` is what is being lifted, and
                          `lastActuals` is keyed by exercise, so the swap
                          moves this line with it and never quotes the
                          planned movement's numbers at a different one. */}
                      {lastTime(entry.exercise_id) && (
                        <div className="microcopy">
                          {lastTime(entry.exercise_id)}
                        </div>
                      )}

                      {entry.substitutedFor && (
                        <div className="microcopy swap-note">
                          Instead of {entry.substitutedFor.name}. The plan’s
                          target still counts here.
                          {swapFrozen(entry)
                            ? " Sets are logged against it, so it stays."
                            : ""}
                        </div>
                      )}

                      {/* Only while nothing has been logged against the swap.
                          Those sets name the chosen exercise and are
                          append-only, so there is nothing left here to undo —
                          see `swapFrozen`. Not mid-correction either: the set
                          being corrected keeps the exercise it was logged
                          under, and offering to change the movement in the
                          same breath only invites the reader to think
                          otherwise. */}
                      {!swapFrozen(entry) && !editing && (
                        <div className="swap-actions">
                          <button
                            type="button"
                            className="swap-action"
                            onClick={() => openSheet("swap")}
                          >
                            {entry.substitutedFor
                              ? "SWAP AGAIN"
                              : "SWAP EXERCISE"}
                          </button>
                          {entry.substitutedFor && (
                            <button
                              type="button"
                              className="swap-action"
                              onClick={() => undoSwap(entry)}
                            >
                              UNDO SWAP
                            </button>
                          )}
                        </div>
                      )}

                      {editing && (
                        <div className="microcopy correcting-note">
                          Correcting set {editing.set.set_index + 1} · was{" "}
                          {toDisplay(
                            enteredKg(
                              editing.set.load_kg,
                              editing.set.load_entry ?? "total",
                            ),
                            unit,
                          )}{" "}
                          {unit}
                          {editing.set.load_entry === "per_side"
                            ? "/side"
                            : ""}{" "}
                          × {editing.set.reps}
                        </div>
                      )}

                      <div className="seg seg-types">
                        {SET_TYPES.map((t) => (
                          <button
                            key={t}
                            type="button"
                            className={`seg-btn ${setType === t ? "seg-on" : ""}`}
                            onClick={() => setSetType(t)}
                          >
                            {t}
                          </button>
                        ))}
                      </div>

                      {/* A tick has no numbers to set. Showing a reps stepper
                        and a load stepper for a banded glute bridge is the
                        thing that made people stop logging the warmup half of
                        a session at all. */}
                      {isTick(entry) ? (
                        <section className="rule-section">
                          <p className="microcopy">
                            No numbers for this one — tap below each time you
                            finish a set.
                          </p>
                        </section>
                      ) : (
                        <>
                          <section className="rule-section">
                            <div className="section-head">
                              <span className="field-label">REPS</span>
                            </div>
                            <Stepper
                              label="reps"
                              inline
                              display={String(reps)}
                              onTapValue={() => openPad("reps")}
                              value={reps}
                              min={0}
                              max={MAX_REPS}
                              onChange={(v) => setReps(Math.round(v))}
                              steps={[
                                { label: "−", delta: -1 },
                                { label: "+", delta: 1 },
                              ]}
                            />
                          </section>

                          <section className="rule-section">
                            <div className="section-head">
                              <span className="field-label">
                                LOAD · {unit.toUpperCase()}
                              </span>
                              {showLoadEntry && (
                                /* a property of the movement, not a per-set choice:
                             it only appears where a pair is possible, and it
                             remembers per exercise like the bar does */
                                <button
                                  type="button"
                                  className="plate-hint"
                                  aria-label={
                                    perSide
                                      ? "load is typed per side; switch to total load"
                                      : "load is typed as the total; switch to per side"
                                  }
                                  onClick={toggleLoadEntry}
                                >
                                  {perSide ? "PER SIDE ×2" : "TOTAL"}
                                </button>
                              )}
                              {hint !== null && (
                                <button
                                  type="button"
                                  className="plate-hint"
                                  onClick={() => openSheet("plates")}
                                >
                                  {hint} ›
                                </button>
                              )}
                            </div>
                            <Stepper
                              label="load"
                              accent
                              display={String(toDisplay(entryKg, unit))}
                              subText={loadSub}
                              onTapValue={() => openPad("load")}
                              snap
                              value={entryKg}
                              min={0}
                              max={maxEntryKg}
                              onChange={setEntryKg}
                              /* labels and deltas both come from the setting, so a
                           custom increment can never make the button lie */
                              steps={loadSteps(entry.exercise_id, unit)}
                            />
                          </section>
                        </>
                      )}

                      {/* Once the plan is met, NEXT leads and extra sets recede.
                        Exactly one of these two is primary at any moment: two
                        filled buttons stacked on a phone read as a choice
                        between equals, and mid-set the lifter should never
                        have to work out which one the app meant. */}
                      <button
                        type="button"
                        className={`btn ${planMet && !editing ? "btn-outline-ink" : "btn-primary"} btn-log`}
                        disabled={logLocked || !setsLoaded || setsFailed}
                        onClick={editing ? saveCorrection : logSet}
                      >
                        {editing
                          ? `SAVE SET ${editing.set.set_index + 1}`
                          : logLabel(entry)}
                      </button>

                      {setsFailed && (
                        <p className="microcopy">
                          This session’s logged sets could not be read from this
                          device, so a new set would be numbered as if nothing
                          had been logged. Reload to try again. Nothing already
                          logged is lost.
                        </p>
                      )}

                      {editing && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-block"
                          onClick={cancelCorrection}
                        >
                          Cancel correction
                        </button>
                      )}

                      {/* The partner mid-superset, the next exercise once the
                          round is over. It leads only once this exercise's
                          own plan is met — the same rule as before, so
                          exactly one of these two buttons is ever primary. */}
                      {advanceTo && !editing && (
                        <button
                          type="button"
                          className={`btn ${planMet ? "btn-primary" : "btn-outline-ink"} btn-block`}
                          onClick={() => setOpenKey(advanceTo.key)}
                        >
                          Next · {advanceTo.name}
                        </button>
                      )}

                      {entrySets.length > 0 && (
                        <section className="rule-section">
                          <div className="section-head">
                            <span className="field-label">LOGGED</span>
                            <span className="section-meta">
                              {done}
                              {total !== null ? ` OF ${total}` : ""}
                            </span>
                          </div>
                          <div className="logged-sets">
                            {entrySets
                              .slice()
                              // set_index is scoped per EXERCISE, so after a
                              // swap two movements in one entry both count
                              // from 0 and the index alone no longer orders
                              // them. When it ties, the clock decides — the
                              // newest set belongs at the top either way.
                              .sort(
                                (a, b) =>
                                  b.set_index - a.set_index ||
                                  b.performed_at.localeCompare(a.performed_at),
                              )
                              .map((s) => (
                                <div key={s.id} className="logged-set-wrap">
                                  <SetRow
                                    set={s}
                                    unit={unit}
                                    restLabel={restAfter(s)}
                                    onVoid={() => voidSet(s)}
                                    voidArmed={voidArm === s.id}
                                    onArmVoid={() => setVoidArm(s.id)}
                                    /* a tick has no numbers to correct */
                                    onEdit={
                                      isTick(entry)
                                        ? undefined
                                        : () => startCorrection(s)
                                    }
                                    editing={editing?.set.id === s.id}
                                  />
                                  {noteEditingId === s.id ? (
                                    <div className="set-note-editor">
                                      <textarea
                                        className="input note-input set-note-input"
                                        rows={2}
                                        autoFocus
                                        enterKeyHint="done"
                                        value={noteDraft}
                                        onChange={(e) =>
                                          setNoteDraft(e.target.value)
                                        }
                                        /* the keyboard animates in over ~250ms;
                                         scroll once it has settled so Save and
                                         Cancel land above it */
                                        onFocus={(e) => {
                                          const el = e.currentTarget
                                            .parentElement as HTMLElement | null;
                                          window.setTimeout(() => {
                                            el?.scrollIntoView({
                                              block: "center",
                                              behavior: prefersReducedMotion()
                                                ? "auto"
                                                : "smooth",
                                            });
                                          }, 300);
                                        }}
                                        placeholder="Note on this set…"
                                      />
                                      <div className="set-note-actions">
                                        <button
                                          type="button"
                                          className="btn btn-ghost"
                                          onClick={() => setNoteEditingId(null)}
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-secondary"
                                          onClick={() => saveNote(s.id)}
                                        >
                                          Save
                                        </button>
                                      </div>
                                    </div>
                                  ) : setNotes[s.id] ? (
                                    <button
                                      type="button"
                                      className="set-note-preview"
                                      onClick={() => openNote(s.id)}
                                    >
                                      {setNotes[s.id]}
                                    </button>
                                  ) : s.id === newestSetId ? (
                                    /* + NOTE on the NEWEST set only. A set that
                                     already HAS a note still shows it (the
                                     branch above), and an older one can still
                                     be annotated by tapping its row — but five
                                     logged sets meant five rows of empty note
                                     chrome, which roughly doubled the height of
                                     this section for an action almost nobody
                                     takes on a set from twenty minutes ago. */
                                    <button
                                      type="button"
                                      className="set-note-add"
                                      onClick={() => openNote(s.id)}
                                    >
                                      + NOTE
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="set-note-add set-note-add-quiet"
                                      aria-label={`add a note to set ${s.set_index + 1}`}
                                      onClick={() => openNote(s.id)}
                                    >
                                      +
                                    </button>
                                  )}
                                </div>
                              ))}
                          </div>
                          {/* Shown on the FIRST set of a session only. It taught
                            something worth knowing once — the set itself is
                            the tap target, ✕ removes — and then repeated
                            itself under every open exercise, in every
                            session, forever. By the third week it was
                            furniture. */}
                          {entrySets.length === 1 && (
                            <div className="microcopy">
                              Wrong number? Tap the set to correct it, or ✕ to
                              remove it.
                            </div>
                          )}
                        </section>
                      )}
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}

          {entries.length === 0 && (
            <p className="microcopy">
              Nothing planned for this session. Add an exercise to start logging
              — load and reps prefill from your last time.
            </p>
          )}
          <button
            type="button"
            className="btn btn-outline-ink btn-block"
            onClick={() => openSheet("search")}
          >
            Add exercise
          </button>
        </section>
      </div>

      {!sheetOpen && (
        <RestTimer
          rest={rest}
          onAdjust={(d) => {
            if (!rest) return;
            const targetSeconds = Math.max(0, rest.targetSeconds + d);
            setRest({ ...rest, targetSeconds });
            mirrorRest(targetSeconds, rest.forLabel);
          }}
          onEdit={() => openPad("rest")}
          /* dismissing hides the strip only: the clock keeps measuring, so
             the mirror keeps its startedAt with a null target */
          onDone={() => {
            setRest(null);
            mirrorRest(null, null);
          }}
        />
      )}

      <div className="session-footer">
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="back to Today — session keeps running"
          onClick={() => navigate("/")}
        >
          Home
        </button>
        <button
          type="button"
          className="btn btn-outline-ink"
          onClick={() => navigate("/end")}
        >
          Finish
        </button>
      </div>

      {sheet === "search" && (
        <ExercisePicker
          title="ADD EXERCISE"
          exercises={allExercises}
          failed={exercisesFailed}
          onPick={(ex) => addExercise(ex)}
          onAddNew={(q) => {
            setSheet(null);
            setNewName(q);
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {/* The same picker, aimed at the open exercise instead of at the end of
          the list. Picking the planned movement back out of it is the undo. */}
      {sheet === "swap" && openEntry && (
        <ExercisePicker
          title="SWAP EXERCISE"
          exercises={allExercises}
          failed={exercisesFailed}
          onPick={(ex) => swapExercise(openEntry, ex)}
          onAddNew={(q) => {
            setSheet(null);
            setNewName(q);
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {newName !== null && (
        <NewExerciseSheet
          initialName={newName}
          exercises={allExercises}
          onPickExisting={(ex) => {
            setNewName(null);
            pickedExercise(ex);
          }}
          onCreated={(ex) => {
            setAllExercises((prev) => [...prev, ex]);
            setNewName(null);
            pickedExercise(ex);
          }}
          onClose={() => setNewName(null)}
        />
      )}

      {declaring && (
        <SetSchemeSheet
          exerciseName={declaring.name}
          equipment={declaring.equipment}
          knownSections={knownSections}
          supersetMembers={supersetMembers}
          unit={unit}
          startKg={
            lastActuals[declaring.id]?.load_kg ?? getPrefillFallback().loadKg
          }
          busy={false}
          onCancel={() => setDeclaring(null)}
          onSave={(groups) => void saveDeclared(declaring, groups)}
        />
      )}

      {sheet === "plates" && openEntry && (
        <PlateSheet
          exerciseId={openEntry.exercise_id}
          exerciseName={openEntry.name}
          targetKg={totalLoadKg}
          unit={unit}
          equipment={equipment}
          onTypeTarget={() => openPad("load", true)}
          onClose={() => setSheet(null)}
        />
      )}

      {req && <NumberPad req={req} />}
    </div>
  );
}
