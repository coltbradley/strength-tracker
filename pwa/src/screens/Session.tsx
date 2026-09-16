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
// - RPE is optional and OFF the set loop: the chips do not exist until the
//   lifter asks for them (per exercise, from the load head, which was already
//   on screen), and the staged value is cleared after every log. Null is the
//   ordinary answer. Rating a set after the fact is a correction like any
//   other, because `sets` is append-only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type StepDef } from "../components/Stepper";
import { Note } from "../components/Note";
import { RestTimer, type ActiveRest } from "../components/RestTimer";
import { SetRow } from "../components/SetRow";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import { PlateSheet } from "../components/PlateSheet";
import { SetEditor, type SetDraft } from "../components/session/SetEditor";
import { SupersetRoundEditor } from "../components/session/SupersetRoundEditor";
import { FocusDeck } from "../components/session/FocusDeck";
import { FocusMoreSheet } from "../components/session/FocusMoreSheet";
import { WorkoutOverview } from "../components/session/WorkoutOverview";
import { RpeChips } from "../components/RpeChips";
import { ExerciseDemoSheet } from "../components/ExerciseDemoSheet";
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
  rxHasNoTm,
} from "../lib/format";
import { reportError, toast } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import {
  useAutoStartRest,
  useExerciseBarKg,
  useExercisePref,
  usePlatesOnHand,
} from "../hooks/useSettings";
import {
  getExerciseBarKg,
  getExercisePref,
  getExerciseRestSeconds,
  setExerciseLoadEntry,
} from "../lib/settings";
import { useWakeLock } from "../hooks/useWakeLock";
import { unlockRestCue } from "../lib/restCue";
import {
  focusEntryKey,
  isFocusEligible,
  pinnedOverviewEntryKey,
  transitionPresentation,
  twoMemberSuperset,
  type SessionPresentation,
} from "../lib/sessionFocus";
import { cancelRestAlert, scheduleRestAlert } from "../lib/push";
import {
  enteredKg,
  isBodyweightEquipment,
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

const LOG_LOCK_MS = 200;
// DB checks: reps between 0 and 100; rest_seconds_actual <= 3600
const MAX_REPS = 100;
const MAX_LOAD_KG = 999;
const MAX_REST_SECONDS = 3600;

type SupersetRoundDraft = {
  keys: readonly [string, string];
  roundIndex: number;
  a1: SetDraft;
  a2: SetDraft;
};

/** A movement with no implement starts at zero load, never at the empty-bar
 *  fallback: in focus mode its load field is hidden, so a 20 kg default would
 *  be logged without anyone seeing it. */
function bodyweightFallback(equipment: string | null) {
  const fallback = getPrefillFallback();
  return isBodyweightEquipment(equipment) ? { ...fallback, loadKg: 0 } : fallback;
}

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
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null);
  // Focus is the default for an eligible session; the mount effect below
  // corrects this to "overview" once sets have loaded and the entries this
  // session actually has (a timed prescription among them, say) are known.
  // `entries` is not computed yet at this point in the render, so this
  // cannot read eligibility directly — the effect is the single source of
  // truth for it.
  const [presentation, setPresentation] =
    useState<SessionPresentation>("focus");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const priorFocusKey = useRef<string | null>(null);

  // The number the USER types. On a per-side exercise it is one side; the
  // total that reaches `sets.load_kg` is derived at the edges (see
  // lib/loadEntry.ts). Seeded from the configured fallback, never a literal.
  const [entryKg, setEntryKg] = useState(() => getPrefillFallback().loadKg);
  const [reps, setReps] = useState(() => getPrefillFallback().reps);
  const [setType, setSetType] = useState<SetType>("working");
  /**
   * The staged rating, and which exercises have asked to see the chips.
   *
   * Two pieces of state because they have opposite lifetimes. The chip ROW is
   * sticky per exercise — asking for it once should not mean asking again
   * every set — while the VALUE is cleared after every log and on every fresh
   * open. Load and reps are sticky because they are a plan that repeats; a
   * rating is an observation of one set, and carrying it forward would invent
   * data nobody stated, silently, on an append-only table.
   *
   * Keyed by exercise rather than by entry: a swap changes the movement, and
   * how the cable felt says nothing about the dumbbell standing in for it.
   */
  const [rpe, setRpe] = useState<number | null>(null);
  const stagedDraftsRef = useRef<Record<string, SetDraft>>({});
  const rememberStagedDraft = (
    entry: ExerciseEntry,
    next: Partial<SetDraft>,
  ) => {
    const key = `${entry.key}:${entry.exercise_id}`;
    const prior = stagedDraftsRef.current[key] ?? {
      entryKg,
      reps,
      setType: setType as BracketKind,
      rpe,
    };
    stagedDraftsRef.current[key] = { ...prior, ...next };
  };
  const [rpeAsked, setRpeAsked] = useState<Set<string>>(new Set());
  const [logLocked, setLogLocked] = useState(false);
  /** True for one `--motion-fast` pulse after a tap lands on the 200 ms
   *  duplicate-LOG lock. The tap did something — it just wasn't a second
   *  insert — and `.is-held` (styles.css) says so instead of the button
   *  silently eating it. */
  const [logHeld, setLogHeld] = useState(false);
  const [roundDrafts, setRoundDrafts] = useState<Record<string, SetDraft>>({});
  const [roundError, setRoundError] = useState<string | null>(null);
  /** Which paired editor owns the ephemeral pad or plate sheet, if either. */
  const [roundInputKey, setRoundInputKey] = useState<string | null>(null);

  const [rest, setRest] = useState<ActiveRest | null>(null);
  // survives DONE so the next log can still record elapsed rest
  const restRef = useRef<{ startedAt: number } | null>(null);

  // The SERVER-side "rest over" push for the strip in progress (lib/push.ts),
  // for when the app is closed or the phone is locked at the deadline.
  //
  // Component state, deliberately not mirrored to the cache: the alert id
  // exists only to CANCEL, and a reload loses it. The server then fires
  // regardless — the person gets a buzz for a rest they may already have
  // ended by relogging after a reload, and that is accepted: a reload
  // mid-rest is rare, one extra buzz is cheap, and a mirrored id that
  // survived would be one more thing to keep consistent with a strip that
  // itself is rehydrated from cache. The rehydrate path below therefore arms
  // nothing.
  //
  // `seq` settles the race between a schedule still in flight and a cancel
  // that arrives before it: the id comes back after the next LOG has already
  // disarmed, so the resolver checks it is still the current rest and
  // cancels what it just scheduled if not. The controller aborts a request
  // that has not left yet.
  const restAlertRef = useRef<{
    seq: number;
    id: string | null;
    controller: AbortController | null;
  }>({ seq: 0, id: null, controller: null });

  const disarmRestAlert = () => {
    const ref = restAlertRef.current;
    ref.seq += 1;
    ref.controller?.abort();
    ref.controller = null;
    const id = ref.id;
    ref.id = null;
    if (id !== null) void cancelRestAlert(id);
  };

  const armRestAlert = (fireAt: number, label: string) => {
    disarmRestAlert();
    // A target already reached (−30 on a rest that is nearly over) has
    // nothing left to announce.
    if (fireAt <= Date.now() + 1000) return;
    const ref = restAlertRef.current;
    const seq = ref.seq;
    const controller = new AbortController();
    ref.controller = controller;
    // Never awaited: the LOG tap must not wait on a network call.
    void scheduleRestAlert(fireAt, label, controller.signal).then((id) => {
      if (id === null) return;
      if (restAlertRef.current.seq === seq) restAlertRef.current.id = id;
      else void cancelRestAlert(id);
    });
  };

  // corrections: voided set ids (append-only voiding) and skipped entry keys
  const [voids, setVoids] = useState<Set<string>>(new Set());
  const [skips, setSkips] = useState<Set<string>>(new Set());
  const [voidArm, setVoidArm] = useArmed();
  // The set being CORRECTED, with the stepper values it displaced so Cancel
  // can put them back. A correction is a void plus a new row at the same
  // index (lib/corrections.ts); this is only the screen's side of it.
  const [editing, setEditing] = useState<{
    set: SetInsert;
    staged: {
      entryKg: number;
      reps: number;
      setType: SetType;
      rpe: number | null;
    };
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
  // Focus mode's one door to everything its default screen hides: RPE, a set
  // note, warmup/working, skip, the plate calculator, correcting or voiding a
  // logged set, last time, and the full LOGGED history. Its own boolean
  // rather than a variant of `sheet` above — those are all Session-owned
  // overlays already keyed by a specific exercise via closures, and folding
  // this in would mean widening that type for a sheet that, unlike the
  // others, needs the CURRENT focus entry (or superset pair) rather than a
  // fixed target passed at open time.
  const [moreOpen, setMoreOpen] = useState(false);
  /** the movement whose how-to sheet is open (photos + steps from the seed) */
  const [demoFor, setDemoFor] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [pad, setPad] = useState<PadSpec | null>(null);
  const [allExercises, setAllExercises] = useState<ExerciseRow[]>([]);
  const [exercisesFailed, setExercisesFailed] = useState(false);

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
        // page evictions); a clock past the recordable window is dropped.
        // No closed-app alert is armed here: the one scheduled before the
        // reload is still the server's to fire (see restAlertRef).
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

  const editingEntryKey = useMemo(() => {
    if (!editing) return null;
    return (
      entries.find((entry) =>
        setsForEntry(entry).some((set) => set.id === editing.set.id),
      )?.key ?? null
    );
  }, [editing, entries, setsForEntry]);

  /**
   * Whether the rating row is on screen for a movement: because somebody
   * asked for it, or because a set of this movement is already rated.
   *
   * The second half is what makes it survive a reload. `rpeAsked` is screen
   * state and dies with the page, and a lifter who has been rating every set
   * should not come back from an app switch to find the row gone and her
   * ratings sitting in LOGGED with no way to add the next one but a rediscovery
   * tap. Reading it off the sets themselves needs no cache and cannot go stale.
   */
  const rpeShown = useCallback(
    (exerciseId: string) =>
      rpeAsked.has(exerciseId) ||
      sets.some((s) => s.exercise_id === exerciseId && s.rpe != null),
    [rpeAsked, sets],
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
  const focusEligible = isFocusEligible(entries);
  const selectedFocusEntry =
    entries.find((entry) => entry.key === focusKey) ?? openEntry;
  const selectedFocusPair = useMemo(
    () => twoMemberSuperset(entries, selectedFocusEntry?.key ?? null),
    [entries, selectedFocusEntry?.key],
  );
  const focusSupersetPair =
    selectedFocusPair !== null && !selectedFocusPair.every(entryDone)
      ? selectedFocusPair
      : null;
  // Selecting A2 in overview still opens the pair from its canonical first
  // member. A round is one unit of work, not two independently focused cards.
  const focusEntry = focusSupersetPair?.[0] ?? selectedFocusEntry;

  // default open: first incomplete entry, once, AFTER sets have merged —
  // otherwise a mid-workout reload opens exercise 1 instead of where the
  // user actually is
  const defaultOpened = useRef(false);
  useEffect(() => {
    if (!setsLoaded || defaultOpened.current || entries.length === 0) return;
    defaultOpened.current = true;
    setOpenKey(entries.find((e) => !entryDone(e))?.key ?? null);
  }, [setsLoaded, entries, entryDone]);

  // Decided once per session start/restore, from the canonical entries this
  // session actually has — never persisted, so a reload always re-derives it
  // rather than promising to restore a visual mode nobody saved.
  const focusPresentationStarted = useRef(false);
  useEffect(() => {
    if (!setsLoaded || focusPresentationStarted.current) return;
    focusPresentationStarted.current = true;
    if (!focusEligible) {
      setPresentation("overview");
      return;
    }
    const key = focusEntryKey(entries, entryDone, openKey);
    setFocusKey(key);
    setOpenKey(key);
    setPresentation("focus");
  }, [entries, entryDone, focusEligible, openKey, setsLoaded]);

  // Focus is meant to read as one exercise at arm's length, so route chrome
  // and the wordmark hide while this screen is actually showing focus. The
  // compact utility group remains in the shared topbar for support and
  // recovery. A body class rather than lifted state keeps App out of Session's
  // presentation decision. Always cleaned up on unmount or mode change.
  useEffect(() => {
    if (presentation !== "focus") return;
    document.body.classList.add("focus-chrome-hidden");
    return () => document.body.classList.remove("focus-chrome-hidden");
  }, [presentation]);

  // The "more" sheet describes ONE exercise (or round); switching what focus
  // is showing under it — by advancing, or by leaving focus altogether —
  // must not leave it open describing something no longer on screen.
  useEffect(() => {
    setMoreOpen(false);
  }, [openKey, presentation]);

  // superset grouping: consecutive entries sharing a non-null group get
  // A1/A2 tags and a bracket rail
  const supersetInfo = useMemo(() => supersetInfoOf(entries), [entries]);

  // The focus deck's own header, for the one case it isn't just the
  // exercise name: a live round replaces "Romanian Deadlift / SET 1 OF 3"
  // with "Superset A" / "round 1 of 3" so the two member names underneath
  // are never named twice on one screen. Mirrors the exhaustion math
  // `renderEditor` uses to build `SupersetRoundEditor`'s (now aria-only)
  // label — kept here too because FocusDeck renders its own header outside
  // that closure. Null falls back to FocusDeck's default (entry name +
  // set position), which covers correction and the plain single-exercise case.
  const focusRoundHeading =
    !editing && presentation === "focus" && focusSupersetPair !== null
      ? (() => {
          const [a1, a2] = focusSupersetPair;
          const letter = (supersetInfo.get(a1.key)?.tag ?? "A1").replace(
            /\d+$/,
            "",
          );
          const progressA = entryProgress(a1);
          const progressB = entryProgress(a2);
          const targetA = targetSets(a1);
          const targetB = targetSets(a2);
          const exhaustedA = targetA > 0 && progressA >= targetA;
          const exhaustedB = targetB > 0 && progressB >= targetB;
          const tail = exhaustedA !== exhaustedB;
          const index = Math.min(progressA, progressB) + 1;
          const total = tail
            ? Math.max(targetA, targetB)
            : Math.min(targetA, targetB);
          return {
            title: `Superset ${letter}`,
            subtitle: `round ${index} of ${total}`,
          };
        })()
      : null;

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
  // Focus's hero is load or reps depending on whether there is an implement
  // at all. Gated to focus mode only (see SetEditor's `noLoad`) — the
  // accordion's long-standing load field is unchanged here.
  // Only while the staged load really is zero: a bodyweight movement with a
  // load staged (a weighted pull-up, or a fallback that got through) must
  // keep its load visible, because `sets` is append-only and a number nobody
  // could see would be logged for good.
  const noLoadEditor =
    presentation === "focus" &&
    isBodyweightEquipment(equipment) &&
    entryKg === 0;
  // per-exercise bar (0 = plate-loaded, e.g. leg press); persisted choice
  const exerciseBarKg = useExerciseBarKg(
    openEntry?.exercise_id ?? null,
    unit,
    equipment,
  );
  const exercisePref = useExercisePref(openEntry?.exercise_id ?? null);

  // ---- accordion -----------------------------------------------------------

  const toggleOpen = (key: string) => {
    setOpenKey((prev) =>
      pinnedOverviewEntryKey(prev === key ? null : key, editingEntryKey),
    );
  };

  const showOverview = () => {
    priorFocusKey.current = openKey;
    // A correction in progress pins the presentation switch to its own
    // entry, the same way `toggleOpen` pins the accordion: a set is being
    // fixed against a specific exercise, and neither an unrelated selection
    // nor the entry that happened to be open before may steal it.
    setOpenKey(editingEntryKey ?? selectedEntryKey ?? priorFocusKey.current);
    setPresentation("overview");
  };

  const enterFocus = () => {
    if (!focusEligible) return;
    if (editingEntryKey) {
      setOpenKey(editingEntryKey);
      setFocusKey(editingEntryKey);
      setPresentation("focus");
      return;
    }
    const next = transitionPresentation(
      presentation,
      "focus",
      selectedEntryKey,
      openKey,
    );
    const key = next.focusKey ?? focusEntryKey(entries, entryDone, openKey);
    setOpenKey(key);
    setFocusKey(key);
    setPresentation(next.presentation);
  };

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

  const prefilledFor = useRef<string | null>(null);
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    // wait for the sets merge: a mid-workout reload otherwise prefills from
    // the wrong bracket and can clobber staged values while a sheet is open.
    // A correction in progress holds `entryKg`/`reps`/`setType`/`rpe` as the
    // set BEING FIXED, not a draft — showOverview/enterFocus pin the open
    // entry to it, but if presentation state ever changes openEntry out from
    // under an active correction some other way, this must not overwrite
    // those staged values with a fresh prefill for whatever is now open. That
    // is how a correction on Bench once saved with Squat's numbers.
    if (!setsLoaded || !openEntry || prefillKey === null || editing) return;
    // Opening an exercise is the one moment the TYPE is decided for you: the
    // plan's outstanding warmup, if it has one. This used to be a flat
    // `setSetType("working")` on every prefill, and logSet reset to working
    // after every log, so a prescribed warmup could only be logged by
    // remembering to tap WARMUP for each one — and tapping it then left the
    // counter stuck, because the same set was counted against the working
    // target. Half a wired feature is worse than none: the honest way to
    // finish the day was to log the warmup as working, at the warmup weight.
    const fresh = openedFor.current !== openEntry.key;
    const draftKey = `${openEntry.key}:${openEntry.exercise_id}`;
    const stagedDraft = fresh ? stagedDraftsRef.current[draftKey] : undefined;
    if (stagedDraft) {
      const savedBracket = bracketFor(
        openEntry,
        countFor(openEntry, stagedDraft.setType),
        stagedDraft.setType,
      );
      openedFor.current = openEntry.key;
      prefilledFor.current = `${openEntry.key}:${openEntry.exercise_id}:${savedBracket?.id ?? "free"}:${stagedDraft.setType}`;
      setEntryKg(stagedDraft.entryKg);
      setReps(stagedDraft.reps);
      setSetType(stagedDraft.setType);
      setRpe(stagedDraft.rpe);
      return;
    }
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
    }, bodyweightFallback(equipment));
    // every source above is a TOTAL; the steppers hold what gets typed
    const prefilledLoad =
      Math.round(enteredKg(p.loadKg, loadEntry) * 100) / 100;
    setEntryKg(prefilledLoad);
    setReps(p.reps);
    if (stagedDraftsRef.current[draftKey]) {
      stagedDraftsRef.current[draftKey] = {
        entryKg: prefilledLoad,
        reps: p.reps,
        setType: stagedKind,
        rpe,
      };
    }
    // Only on a fresh open. After that the toggle belongs to the lifter (and
    // to logSet, which advances it as the plan's warmups are used up):
    // writing it here on every bracket change would fight a deliberate tap.
    // The rating is cleared on the same beat and for the same reason it is
    // cleared after every log: it is an observation of one set, and how the
    // last exercise felt is not a claim about this one.
    if (fresh) {
      setSetType(openingKind);
      setRpe(null);
    }
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

  /** A tap on LOG (or Log round / Log A1 only / Log A2 only) that lands on
   *  the 200 ms duplicate-tap lock must not read as nothing happening: it
   *  flashes the button once (`.is-held`, `--motion-fast`) and drops the
   *  tap. Never wraps a correction — Decision 6 is that corrections and
   *  every other control are never locked, and `saveCorrection` no longer
   *  checks `logLocked` at all (see below). 120 ms mirrors the
   *  `--motion-fast` token Task 3 adds to styles.css; kept as a literal here
   *  so this does not depend on that task's edit landing first. */
  const tapLog = (action: () => void) => {
    if (logLocked) {
      setLogHeld(true);
      window.setTimeout(() => setLogHeld(false), 120);
      return;
    }
    action();
  };

  /** Build every ordinary set shape before it reaches the durable outbox. */
  const buildSetInsert = (
    entry: ExerciseEntry,
    draft: SetDraft,
    bracket: ResolvedPrescriptionRow | null,
    entryMode: LoadEntry,
    index: number,
    actualRest: number | null,
  ): SetInsert => {
    const storedLoad = totalKg(draft.entryKg, entryMode);
    const tick = isTick(entry);
    return {
      id: uuid(),
      session_id: sessionId as string,
      exercise_id: entry.exercise_id,
      prescription_id: isLocalBracket(bracket?.id)
        ? null
        : (bracket?.id ?? null),
      set_index: index,
      set_type: draft.setType,
      load_kg: tick ? 0 : Math.round(storedLoad * 100) / 100,
      reps: tick ? 0 : draft.reps,
      performed_at: new Date().toISOString(),
      rest_seconds_actual: actualRest,
      load_entry: loadEntryForSet(entryMode, storedLoad),
      rpe: tick ? null : draft.rpe,
    };
  };

  const setIndexFor = (exerciseId: string): number =>
    setsRef.current
      .filter((set) => set.exercise_id === exerciseId)
      .reduce((max, set) => Math.max(max, set.set_index), -1) + 1;

  const logSet = (
    loggedDraft: SetDraft = {
      entryKg,
      reps,
      setType: setType as BracketKind,
      rpe,
    },
    entryToLog: ExerciseEntry | null = openEntry,
  ) => {
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
    if (!entryToLog || !sessionId || logLocked || !setsLoaded || setsFailed)
      return;
    delete stagedDraftsRef.current[
      `${entryToLog.key}:${entryToLog.exercise_id}`
    ];
    setLogLocked(true);
    window.setTimeout(() => setLogLocked(false), LOG_LOCK_MS);
    setVoidArm(null);
    // logging on a skipped exercise means it's happening after all
    if (skips.has(entryToLog.key)) {
      const unskipped = new Set(skips);
      unskipped.delete(entryToLog.key);
      persistSkips(unskipped);
    }

    const nextIndex = setIndexFor(entryToLog.exercise_id);
    const bracket = bracketFor(
      entryToLog,
      countFor(entryToLog, loggedDraft.setType),
      loggedDraft.setType,
    );
    const targetLoadEntry = resolveLoadEntry({
      override: getExercisePref(entryToLog.exercise_id).loadEntry,
      prescribed: entryToLog.substitutedFor
        ? null
        : (bracket?.load_entry ?? null),
      equipment: equipMap[entryToLog.exercise_id] ?? null,
      name: entryToLog.name,
    });
    const set = buildSetInsert(
      entryToLog,
      loggedDraft,
      bracket,
      targetLoadEntry,
      nextIndex,
      recordableRest(),
    );
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
      (skips.has(e.key) && e.key !== entryToLog.key) ||
      entryMet(e, setsForEntryOf(e, next, rx, knownRxIds));
    // Mid-superset the rest strip is a countdown to nothing: the next thing
    // to do is the partner, not a wait. Only the STRIP is held — the clock
    // below always starts, because `rest_seconds_actual` is data and
    // append-only, so a rest not measured now can never be recorded later.
    const roundOpen = supersetPartnerOf(entries, entryToLog.key, doneAfter);

    // The clock always starts MEASURING (rest_seconds_actual is data, and
    // append-only means it can never be added later); auto-start governs only
    // whether the strip appears.
    const now = Date.now();
    restRef.current = { startedAt: now };
    const forLabel = `${entryToLog.name} set ${nextIndex + 1}`;
    const targetRestSeconds = getExerciseRestSeconds(
      entryToLog.exercise_id,
      bracket?.rest_seconds ?? null,
    );
    const showStrip = autoStartRest && roundOpen === null;
    if (showStrip)
      setRest({ startedAt: now, targetSeconds: targetRestSeconds, forLabel });
    // The next LOG cancels the previous rest's closed-app alert whatever
    // happens to the strip, and arms one for this rest only when a strip is
    // shown: no strip means mid-superset or auto-start off, and neither wants
    // a buzz.
    disarmRestAlert();
    if (showStrip) armRestAlert(now + targetRestSeconds * 1000, forLabel);
    // Mirror the clock HERE, whether or not a strip appeared. With auto-start
    // off nothing about `rest` changes, so nothing else would ever write the
    // new startedAt — and no strip also means there is none to restore, which
    // is the null target.
    mirrorRest(
      showStrip ? targetRestSeconds : null,
      showStrip ? forLabel : null,
    );
    // What the NEXT set should be, from the plan rather than from a reset:
    // this was an unconditional "working", so a coach's second prescribed
    // warmup arrived pre-set to working and got logged as one.
    const warmupsLogged = setsForEntryOf(
      entryToLog,
      next,
      rx,
      knownRxIds,
    ).filter((s) => s.set_type === "warmup").length;
    if (entryToLog.key === openEntry?.key)
      setSetType(warmupsLogged < warmupSets(entryToLog) ? "warmup" : "working");
    // The rating does NOT carry to the next set. Load and reps do, because
    // they are the plan repeating; how hard set 3 felt is not a prediction
    // about set 4, and a sticky value would quietly attach one lifter's one
    // honest answer to every row after it.
    setRpe(null);
  };

  const logRound = async (round: SupersetRoundDraft) => {
    // Kept synchronous with the tap: iOS will only permit this cue unlock in
    // a user gesture, not after the durable local queue awaits.
    unlockRestCue();
    if (!sessionId || logLocked || !setsLoaded || setsFailed) return;
    const first = entries.find((entry) => entry.key === round.keys[0]);
    const second = entries.find((entry) => entry.key === round.keys[1]);
    if (!first || !second) return;
    const members = [first, second] as const;

    setLogLocked(true);
    setVoidArm(null);
    // logging on a skipped exercise means it's happening after all — same
    // rule as logSet, applied to whichever round member(s) were skipped.
    if (skips.has(first.key) || skips.has(second.key)) {
      const unskipped = new Set(skips);
      unskipped.delete(first.key);
      unskipped.delete(second.key);
      persistSkips(unskipped);
    }
    const actualRest = recordableRest();
    const nextByExercise = new Map<string, number>();
    const nextIndex = (exerciseId: string) => {
      const value = nextByExercise.get(exerciseId) ?? setIndexFor(exerciseId);
      nextByExercise.set(exerciseId, value + 1);
      return value;
    };
    const buildRoundSet = (
      entry: ExerciseEntry,
      draft: SetDraft,
      restSecondsActual: number | null,
    ) => {
      const bracket = bracketFor(
        entry,
        countFor(entry, draft.setType),
        draft.setType,
      );
      const entryMode = resolveLoadEntry({
        override: getExercisePref(entry.exercise_id).loadEntry,
        prescribed: entry.substitutedFor ? null : (bracket?.load_entry ?? null),
        equipment: equipMap[entry.exercise_id] ?? null,
        name: entry.name,
      });
      return buildSetInsert(
        entry,
        draft,
        bracket,
        entryMode,
        nextIndex(entry.exercise_id),
        restSecondsActual,
      );
    };
    // A round is one tap: A1 and A2 land together, so only A1 (the round's
    // first member) was actually rested for `actualRest` — that clock ran
    // from the last set logged, which was A2's previous round. A2 itself did
    // not rest at all; recording A1's elapsed time against it too would
    // double-count one rest as two, so its own rest is unknown (null), the
    // same as any other set whose rest was never measured.
    const secondBracket = bracketFor(
      second,
      countFor(second, round.a2.setType),
      round.a2.setType,
    );
    // The rest that follows THIS round is the one the coach wrote for
    // whichever exercise was just performed last — A2, matching `forLabel`
    // below — never the top-level `restSeconds` hook value, which reflects
    // whichever entry happens to be `openEntry` (often A1, and possibly a
    // different bracket_rest_seconds entirely).
    const roundRestSeconds = getExerciseRestSeconds(
      second.exercise_id,
      secondBracket?.rest_seconds ?? null,
    );
    const inserts = [
      buildRoundSet(first, round.a1, actualRest),
      buildRoundSet(second, round.a2, null),
    ];

    try {
      // This transaction is the local commit point. No set reaches React or
      // the cache until both queue rows exist together in IndexedDB.
      await outbox.enqueueBatch(
        inserts.map((payload) => ({
          kind: "insert" as const,
          table: "sets" as const,
          payload,
        })),
      );
      const next = applySets((prior) => [...prior, ...inserts]);
      cacheSet(cacheKeys.sessionSets(sessionId), next).catch((error: unknown) =>
        reportError(error, "cache superset round"),
      );
      setRoundDrafts((prior) => {
        const next = { ...prior };
        delete next[round.keys[0]];
        delete next[round.keys[1]];
        return next;
      });
      for (const entry of members)
        delete stagedDraftsRef.current[`${entry.key}:${entry.exercise_id}`];
      setRoundError(null);

      // What the NEXT round should stage, from the plan rather than a stale
      // toggle — the same carry-over logSet does. Only the member that IS
      // the open entry needs it here: `roundDraftFor` reads the top-level
      // `setType` for that one and recomputes a fresh default for the other
      // on every render, so the other member's warmup->working transition
      // already happens on its own from the updated `sets`.
      for (const entry of members) {
        if (entry.key !== openEntry?.key) continue;
        const warmupsLogged = setsForEntryOf(
          entry,
          next,
          rx,
          knownRxIds,
        ).filter((s) => s.set_type === "warmup").length;
        setSetType(warmupsLogged < warmupSets(entry) ? "warmup" : "working");
      }

      const doneAfter = (entry: ExerciseEntry): boolean =>
        skips.has(entry.key) ||
        entryMet(entry, setsForEntryOf(entry, next, rx, knownRxIds));
      const now = Date.now();
      restRef.current = { startedAt: now };
      const forLabel = `${members[1].name} set ${inserts[1].set_index + 1}`;
      const showStrip =
        autoStartRest &&
        supersetPartnerOf(entries, members[0].key, doneAfter) === null;
      if (showStrip)
        setRest({ startedAt: now, targetSeconds: roundRestSeconds, forLabel });
      disarmRestAlert();
      if (showStrip) armRestAlert(now + roundRestSeconds * 1000, forLabel);
      mirrorRest(
        showStrip ? roundRestSeconds : null,
        showStrip ? forLabel : null,
      );
    } catch (error) {
      reportError(error, "queue superset round");
      setRoundError(
        "This round could not be saved locally. Check storage and retry.",
      );
    } finally {
      window.setTimeout(() => setLogLocked(false), LOG_LOCK_MS);
    }
  };

  const openSheet = (
    kind: "search" | "swap" | "plates",
    memberKey: string | null = null,
  ) => {
    setRoundInputKey(memberKey);
    setSheet(kind);
    setPad(null);
    // Which door was opened is recorded HERE rather than at each call site, so
    // the create-exercise sheet behind the picker can never send a substitute
    // to the end of the list because somebody forgot to say so.
    if (kind === "search") setPicking("add");
    if (kind === "swap") setPicking("swap");
  };

  const openPad = (
    kind: PadKind,
    fromPlates = false,
    memberKey: string | null = null,
  ) => {
    setRoundInputKey(memberKey);
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
    // Correcting a set — reached from focus mode only via the "more" sheet's
    // LOGGED list — is a deliberate switch to the hero editor. Leaving the
    // sheet open over it would show SAVE/Cancel behind an overlay meant for
    // browsing, not for the one active edit.
    setMoreOpen(false);
    // Only the first tap displaces the staged values; re-tapping a different
    // set mid-correction must still restore what was there BEFORE editing.
    const staged = editing?.staged ?? { entryKg, reps, setType, rpe };
    setEditing({ set: s, staged });
    // load_kg is the TOTAL; show it in whatever convention the exercise is
    // in NOW, so Save — which totals the entry by that same convention —
    // round-trips exactly even if the toggle was flipped since the set.
    setEntryKg(Math.round(enteredKg(s.load_kg, loadEntry) * 100) / 100);
    setReps(s.reps);
    setSetType(s.set_type);
    // A correction is the only way to rate a set after the fact, so the row's
    // rating comes into the chips exactly as its load and reps do. `rpeShown`
    // is already true for a rated set; an unrated one still needs the reveal,
    // which is the same one tap it always was.
    setRpe(s.rpe ?? null);
  };

  const cancelCorrection = () => {
    if (!editing) return;
    setEntryKg(editing.staged.entryKg);
    setReps(editing.staged.reps);
    setSetType(editing.staged.setType);
    setRpe(editing.staged.rpe);
    setEditing(null);
  };

  /** Void the old row and append its replacement at the same set_index.
   *  Nothing about WHEN the set happened changes: performed_at, the rest
   *  before it and the rest clock after it all stand. */
  const saveCorrection = () => {
    // Corrections are never gated by the log lock (Decision 6): the lock
    // exists only to stop a double LOG tap inserting the same set twice, and
    // a correction is a deliberate edit to a set that already exists. It
    // must not engage the lock either — before this, correcting a set right
    // after logging one silently blocked the NEXT log for up to 400 ms.
    if (!editing || !sessionId) return;
    const old = editing.set;
    const correction = {
      load_kg: Math.round(totalLoadKg * 100) / 100,
      reps,
      set_type: setType,
      load_entry: loadEntryForSet(loadEntry, totalLoadKg),
      rpe,
    };
    if (isNoopCorrection(old, correction)) {
      cancelCorrection();
      return;
    }
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
    setRpe(editing.staged.rpe);
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
      disarmRestAlert();
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
    const roundEntry =
      roundInputKey === null
        ? null
        : (entries.find((entry) => entry.key === roundInputKey) ?? null);
    if (roundEntry && pad.kind !== "rest") {
      const draft = roundDraftFor(roundEntry);
      const bracket = bracketFor(
        roundEntry,
        countFor(roundEntry, draft.setType),
        draft.setType,
      );
      const entryMode = resolveLoadEntry({
        override: getExercisePref(roundEntry.exercise_id).loadEntry,
        prescribed: roundEntry.substitutedFor
          ? null
          : (bracket?.load_entry ?? null),
        equipment: equipMap[roundEntry.exercise_id] ?? null,
        name: roundEntry.name,
      });
      const updateDraft = (next: Partial<SetDraft>) =>
        setRoundDrafts((prior) => ({
          ...prior,
          [roundEntry.key]: { ...draft, ...next },
        }));
      if (pad.kind === "load") {
        const perSideRound = entryMode === "per_side";
        const max = perSideRound ? MAX_LOAD_KG / 2 : MAX_LOAD_KG;
        return {
          label: `${roundEntry.name.toUpperCase()} · ${
            perSideRound ? "WEIGHT ON EACH DUMBBELL" : "ONE TOTAL WEIGHT"
          } IN ${unit.toUpperCase()}`,
          action: pad.fromPlates ? "BACK TO PLATES" : "SET LOAD",
          initial: String(toDisplay(draft.entryKg, unit)),
          allowDecimal: true,
          onCommit: (value) => {
            const kg = Math.min(max, Math.max(0, fromDisplay(value, unit)));
            updateDraft({ entryKg: Math.round(kg * 100) / 100 });
            setPad(null);
            if (pad.fromPlates) setSheet("plates");
          },
          onCancel: () => {
            setPad(null);
            if (pad.fromPlates) setSheet("plates");
          },
        };
      }
      return {
        label: `${roundEntry.name.toUpperCase()} · REPS`,
        action: "SET REPS",
        initial: String(draft.reps),
        allowDecimal: false,
        onCommit: (value) => {
          updateDraft({
            reps: Math.min(MAX_REPS, Math.max(0, Math.round(value))),
          });
          setPad(null);
        },
        onCancel: () => setPad(null),
      };
    }
    const U = unit.toUpperCase();
    if (pad.kind === "load") {
      return {
        label: `${openEntry.name.toUpperCase()} · ${
          perSide ? "WEIGHT ON EACH DUMBBELL" : "ONE TOTAL WEIGHT"
        } IN ${U}`,
        action: pad.fromPlates ? "BACK TO PLATES" : "SET LOAD",
        initial: String(toDisplay(entryKg, unit)),
        allowDecimal: true,
        onCommit: (v) => {
          const kg = Math.min(maxEntryKg, Math.max(0, fromDisplay(v, unit)));
          const entryKg = Math.round(kg * 100) / 100;
          rememberStagedDraft(openEntry, { entryKg });
          setEntryKg(entryKg);
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
          const reps = Math.min(MAX_REPS, Math.max(0, Math.round(v)));
          rememberStagedDraft(openEntry, { reps });
          setReps(reps);
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
          armRestAlert(rest.startedAt + (nowEl + want) * 1000, rest.forLabel);
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

  /**
   * `part` decides which of this entry's three pieces render:
   *  - "full" (the accordion, unchanged): context (target/last-time/swap),
   *    the editor, and the full LOGGED history, in that order.
   *  - "hero" (focus mode's default screen): just the correcting note (when
   *    a correction is in progress — that state was entered deliberately and
   *    stays visible) and the editor itself. Context and LOGGED are left to
   *    "detail" so the default screen stays to the load/reps and LOG.
   *  - "detail" (focus mode's "more" sheet): context, the correcting note,
   *    and the full LOGGED history — everything "hero" leaves out. Never the
   *    editor itself: the hero editor is not duplicated into the sheet.
   */
  const renderEditor = (
    entry: ExerciseEntry,
    showAdvance = true,
    part: "full" | "hero" | "detail" = "full",
  ) => {
    const prescribed = entry.brackets.length > 0;
    const done = entryProgress(entry);
    const total = prescribed ? targetSets(entry) : null;
    const planMet = total !== null && done >= total;
    const pairedRound =
      !editing &&
      presentation === "focus" &&
      focusSupersetPair !== null &&
      !focusSupersetPair.every(entryDone) &&
      entry.key === focusSupersetPair[0].key;
    const roundA1 = pairedRound ? roundDraftFor(focusSupersetPair[0]) : null;
    const roundA2 = pairedRound ? roundDraftFor(focusSupersetPair[1]) : null;
    const roundTagA1 = pairedRound
      ? (supersetInfo.get(focusSupersetPair[0].key)?.tag ?? "A1")
      : "A1";
    const roundTagA2 = pairedRound
      ? (supersetInfo.get(focusSupersetPair[1].key)?.tag ?? "A2")
      : "A2";
    const roundLetter = roundTagA1.replace(/\d+$/, "");
    // A member with a numeric target it has already MET has nothing left to
    // pair with a partner still short of its own — the round is over for it,
    // even though its raw progress can still equal the partner's (both
    // logged 3 when A1's target was 3 and A2's was 4). Without distinguishing
    // "exhausted" from merely "equal progress", that equality read as one
    // more full round, offering "Log round" to add an unprescribed 4th set to
    // A1 alongside A2's legitimate one, and the label undercounted the day's
    // real round total.
    const roundProgressA = pairedRound
      ? entryProgress(focusSupersetPair[0])
      : 0;
    const roundProgressB = pairedRound
      ? entryProgress(focusSupersetPair[1])
      : 0;
    const roundTargetA = pairedRound ? targetSets(focusSupersetPair[0]) : 0;
    const roundTargetB = pairedRound ? targetSets(focusSupersetPair[1]) : 0;
    const roundExhaustedA = roundTargetA > 0 && roundProgressA >= roundTargetA;
    const roundExhaustedB = roundTargetB > 0 && roundProgressB >= roundTargetB;
    const roundTail = roundExhaustedA !== roundExhaustedB;
    const roundIndex = pairedRound
      ? Math.min(roundProgressA, roundProgressB) + 1
      : 0;
    const roundTotal = pairedRound
      ? roundTail
        ? Math.max(roundTargetA, roundTargetB)
        : Math.min(roundTargetA, roundTargetB)
      : 0;
    const pendingRoundMember = pairedRound
      ? roundTail
        ? roundExhaustedA
          ? "a2"
          : "a1"
        : roundProgressA === roundProgressB
          ? null
          : roundProgressA < roundProgressB
            ? "a1"
            : "a2"
      : null;

    const contextBlock = (
      <>
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
              {entry.brackets.some(rxHasNoTm) ? " · NO TM SET" : ""}
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
          <div className="microcopy">{lastTime(entry.exercise_id)}</div>
        )}

        {entry.substitutedFor && (
          <div className="microcopy swap-note">
            Instead of {entry.substitutedFor.name}. The plan’s target still
            counts here.
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
              {entry.substitutedFor ? "SWAP AGAIN" : "SWAP EXERCISE"}
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
      </>
    );

    // The correction in progress is a state the lifter entered deliberately
    // (tapping a logged set in "detail"), so it stays visible in "hero" too —
    // unlike the rest of contextBlock, hiding this one would leave SAVE/
    // Cancel on screen with no explanation of what they apply to.
    const correctingNote = editing && (
      <div className="microcopy correcting-note">
        Correcting set {editing.set.set_index + 1} · was{" "}
        {toDisplay(
          enteredKg(editing.set.load_kg, editing.set.load_entry ?? "total"),
          unit,
        )}{" "}
        {unit}
        {editing.set.load_entry === "per_side" ? "/side" : ""} ×{" "}
        {editing.set.reps}
      </div>
    );

    const editorBlock = (
      <>
        {pairedRound && roundA1 && roundA2 ? (
          <SupersetRoundEditor
            label={`SUPERSET ${roundLetter} · ROUND ${roundIndex} OF ${roundTotal}`}
            a1={{
              tag: roundTagA1,
              editor: roundEditorFor(focusSupersetPair[0], roundA1),
            }}
            a2={{
              tag: roundTagA2,
              editor: roundEditorFor(focusSupersetPair[1], roundA2),
            }}
            disabled={!setsLoaded || setsFailed}
            heldPulse={logHeld}
            error={roundError}
            singleLogLabel={`Log ${roundTagA1} only`}
            pendingMember={pendingRoundMember}
            onLogRound={(drafts) =>
              tapLog(() =>
                void logRound({
                  keys: [focusSupersetPair[0].key, focusSupersetPair[1].key],
                  roundIndex,
                  a1: drafts.a1,
                  a2: drafts.a2,
                }),
              )
            }
            onLogA1Only={() =>
              tapLog(() => {
                if (!sessionId || !setsLoaded || setsFailed) return;
                logSet(roundA1, focusSupersetPair[0]);
                setRoundDrafts((prior) => {
                  const next = { ...prior };
                  delete next[focusSupersetPair[0].key];
                  return next;
                });
              })
            }
            onLogA2Only={() =>
              tapLog(() => {
                if (!sessionId || !setsLoaded || setsFailed) return;
                logSet(roundA2, focusSupersetPair[1]);
                setRoundDrafts((prior) => {
                  const next = { ...prior };
                  delete next[focusSupersetPair[1].key];
                  return next;
                });
              })
            }
          />
        ) : (
          <SetEditor
            entry={entry}
            /* A legacy backoff is legal historical data but not a
                           selectable kind. Passing it through preserves an
                           unchanged correction until the lifter picks one of
                           the two supported kinds. */
            draft={{
              entryKg,
              reps,
              setType: setType as BracketKind,
              rpe,
            }}
            tracking={isTick(entry) ? "done" : "reps"}
            loadPresentation={{
              perSide,
              totalKg: totalLoadKg,
              plateSplit,
              barKg: exerciseBarKg,
              hint,
              canToggleEntry: offersLoadEntry(loadEntryInput),
              noLoad: noLoadEditor,
            }}
            unit={unit}
            maxEntryKg={maxEntryKg}
            loadSteps={loadSteps(entry.exercise_id, unit)}
            rpeShown={rpeShown(entry.exercise_id)}
            logLabel={
              editing
                ? `SAVE SET ${editing.set.set_index + 1}`
                : presentation === "focus" && workoutDone
                  ? "FINISH"
                  : presentation === "focus"
                    ? isTick(entry)
                      ? "DONE"
                      : "LOG SET"
                    : logLabel(entry)
            }
            logClassName={`btn ${planMet && !editing ? "btn-outline-ink" : "btn-primary"} btn-log${logHeld && !editing ? " is-held" : ""}`}
            // A correction is a deliberate, one-off edit to history, exempt
            // from focus mode's default minimalism: every field (type, RPE,
            // fine adjustment) stays inline and reachable rather than behind
            // "more", which is closed the moment a correction starts anyway
            // (see `startCorrection`).
            variant={
              presentation === "focus" && !editing ? "focus" : "overview"
            }
            lastPerformance={
              presentation === "focus" && !isTick(entry)
                ? lastTime(entry.exercise_id, true, noLoadEditor)
                : null
            }
            restSlot={restInline && !sheetOpen ? restTimerEl : undefined}
            disabled={!setsLoaded || setsFailed}
            onDraftChange={(next) => {
              if (!editing) rememberStagedDraft(entry, next);
              if (next.entryKg !== undefined) setEntryKg(next.entryKg);
              if (next.reps !== undefined) setReps(next.reps);
              if (next.setType !== undefined) setSetType(next.setType);
              if (next.rpe !== undefined) setRpe(next.rpe);
            }}
            onLog={
              editing
                ? saveCorrection
                : presentation === "focus" && workoutDone
                  ? finishWorkout
                  : () => tapLog(() => logSet())
            }
            onOpenPlates={() => openSheet("plates")}
            onOpenPad={openPad}
            onToggleLoadEntry={toggleLoadEntry}
            onRevealRpe={() =>
              setRpeAsked((prev) => new Set([...prev, entry.exercise_id]))
            }
          />
        )}

        {setsFailed && (
          <p className="microcopy">
            This session’s logged sets could not be read from this device, so a
            new set would be numbered as if nothing had been logged. Reload to
            try again. Nothing already logged is lost.
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
        {showAdvance && advanceTo && !editing && (
          <button
            type="button"
            className={`btn ${planMet ? "btn-primary" : "btn-outline-ink"} btn-block`}
            onClick={() => setOpenKey(advanceTo.key)}
          >
            Next · {advanceTo.name}
          </button>
        )}
      </>
    );

    // Scoped to THIS entry, not the outer `entrySets` (which tracks
    // `openEntry`): a superset's "detail" view calls this twice, once per
    // member, and each one's own logged history must follow its own
    // exercise — reading the outer, single-entry value here would show A1's
    // sets under A2's heading whenever A2 is not the entry currently open.
    const entrySetsForThis = setsForEntry(entry);
    const newestSetIdForThis =
      entrySetsForThis.length === 0
        ? null
        : entrySetsForThis.reduce((a, b) =>
            b.set_index > a.set_index ||
            (b.set_index === a.set_index && b.performed_at > a.performed_at)
              ? b
              : a,
          ).id;

    const loggedBlock = entrySetsForThis.length > 0 && (
      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">LOGGED</span>
          <span className="section-meta">
            {done}
            {total !== null ? ` OF ${total}` : ""}
          </span>
        </div>
        <div className="logged-sets">
          {entrySetsForThis
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
                  onEdit={isTick(entry) ? undefined : () => startCorrection(s)}
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
                      onChange={(e) => setNoteDraft(e.target.value)}
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
                ) : s.id === newestSetIdForThis ? (
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
        {entrySetsForThis.length === 1 && (
          <div className="microcopy">
            Wrong number? Tap the set to correct it, or ✕ to remove it.
          </div>
        )}
      </section>
    );

    if (part === "hero") {
      return (
        <>
          {correctingNote}
          {editorBlock}
        </>
      );
    }
    if (part === "detail") {
      return (
        <>
          {contextBlock}
          {correctingNote}
          {loggedBlock}
        </>
      );
    }
    return (
      <>
        {contextBlock}
        {correctingNote}
        {editorBlock}
        {loggedBlock}
      </>
    );
  };

  /** The draft + change handler for whichever entry the "more" sheet is
   *  currently showing a warmup/working toggle or RPE row for — the round
   *  drafts for a paired superset member, or the top-level staged draft
   *  otherwise. Mirrors `roundEditorFor`'s and the plain `<SetEditor>`'s own
   *  `onDraftChange` exactly, so a set type or RPE change made from the
   *  sheet is indistinguishable from one made through the hero editor. */
  const moreDraftFor = (
    target: ExerciseEntry,
  ): { draft: SetDraft; onChange: (next: Partial<SetDraft>) => void } => {
    if (
      focusSupersetPair &&
      (target.key === focusSupersetPair[0].key ||
        target.key === focusSupersetPair[1].key)
    ) {
      return {
        draft: roundDraftFor(target),
        onChange: (next) => {
          setRoundDrafts((prior) => ({
            ...prior,
            [target.key]: { ...roundDraftFor(target), ...next },
          }));
          setRoundError(null);
        },
      };
    }
    return {
      draft: { entryKg, reps, setType: setType as BracketKind, rpe },
      onChange: (next) => {
        if (!editing) rememberStagedDraft(target, next);
        if (next.entryKg !== undefined) setEntryKg(next.entryKg);
        if (next.reps !== undefined) setReps(next.reps);
        if (next.setType !== undefined) setSetType(next.setType);
        if (next.rpe !== undefined) setRpe(next.rpe);
      },
    };
  };

  /** Warmup/working, RPE, skip, the plate calculator, and the per-hand/total
   *  toggle for ONE entry — everything the focus hero used to show inline,
   *  now living only in the "more" sheet. A tick exercise has no numeric
   *  draft to fine-tune (see `SetEditor`'s own `tracking === "done"`
   *  branch), so only skip is offered for one. */
  const moreExtrasFor = (target: ExerciseEntry) => {
    const skipped = skips.has(target.key);
    const skipAction = (
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => toggleSkip(target)}
      >
        {skipped ? "UNSKIP" : "SKIP"}
      </button>
    );
    if (isTick(target)) {
      return <div className="focus-more-actions">{skipAction}</div>;
    }
    const targetEquipment = equipMap[target.exercise_id] ?? null;
    const targetPlateable =
      targetEquipment === "barbell" || targetEquipment === "machine";
    const targetLoadEntryInput = {
      override: getExercisePref(target.exercise_id).loadEntry,
      prescribed: target.substitutedFor
        ? null
        : (target.brackets[0]?.load_entry ?? null),
      equipment: targetEquipment,
      name: target.name,
    };
    const targetCanToggle = offersLoadEntry(targetLoadEntryInput);
    const targetLoadEntry = resolveLoadEntry(targetLoadEntryInput);
    const { draft, onChange } = moreDraftFor(target);
    return (
      <div className="focus-more-extras">
        <div className="seg seg-types">
          {(["warmup", "working"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`seg-btn ${draft.setType === t ? "seg-on" : ""}`}
              onClick={() => onChange({ setType: t })}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="focus-more-actions">
          {targetPlateable && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => openSheet("plates", target.key)}
            >
              Plate calculator
            </button>
          )}
          {targetCanToggle && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                setExerciseLoadEntry(
                  target.exercise_id,
                  targetLoadEntry === "per_side" ? "total" : "per_side",
                )
              }
            >
              {targetLoadEntry === "per_side"
                ? "each hand"
                : "one total weight"}
            </button>
          )}
          {skipAction}
        </div>
        <RpeChips
          shown
          value={draft.rpe}
          onChange={(rpe) => onChange({ rpe })}
        />
      </div>
    );
  };

  // plate maths is always about the whole loaded implement
  const plateSplit = plateable
    ? split(totalLoadKg, exerciseBarKg, inventory)
    : null;
  const hint = plateSplit
    ? (() => {
        const r = plateSplit;
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
  const lastTime = (
    exerciseId: string,
    latestOnly = false,
    repsOnly = false,
    entryMode: LoadEntry = loadEntry,
  ): string | null => {
    const a = lastActuals[exerciseId];
    if (!a) return null;
    const shown = (kg: number) =>
      `${toDisplay(enteredKg(kg, entryMode), unit)} ${unit}${entryMode === "per_side" ? "/side" : ""}`;
    if (latestOnly)
      return repsOnly
        ? `Last time · ${a.reps} reps`
        : `Last time · ${shown(a.load_kg)} × ${a.reps}`;
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

  const defaultRoundDraft = (entry: ExerciseEntry): SetDraft => {
    const kind = suggestedKind(entry);
    const bracket = bracketFor(entry, countFor(entry, kind), kind);
    const entryMode = resolveLoadEntry({
      override: getExercisePref(entry.exercise_id).loadEntry,
      prescribed: entry.substitutedFor ? null : (bracket?.load_entry ?? null),
      equipment: equipMap[entry.exercise_id] ?? null,
      name: entry.name,
    });
    const last = setsForExercise(entry.exercise_id).at(-1);
    const prefill = prefillSet({
      prescription: bracket
        ? {
            resolved_load_kg: entry.substitutedFor
              ? null
              : bracket.resolved_load_kg,
            plate_load_kg: entry.substitutedFor ? null : bracket.plate_load_kg,
            reps_min: bracket.reps_min,
            reps_max: bracket.reps_max,
          }
        : null,
      lastThisSession: last ? { load_kg: last.load_kg, reps: last.reps } : null,
      lastSession: lastActuals[entry.exercise_id] ?? null,
    }, bodyweightFallback(equipMap[entry.exercise_id] ?? null));
    return {
      entryKg: Math.round(enteredKg(prefill.loadKg, entryMode) * 100) / 100,
      reps: prefill.reps,
      setType: kind,
      rpe: null,
    };
  };

  const roundDraftFor = (entry: ExerciseEntry): SetDraft =>
    roundDrafts[entry.key] ??
    (entry.key === openEntry?.key
      ? { entryKg, reps, setType: setType as BracketKind, rpe }
      : defaultRoundDraft(entry));

  const roundEditorFor = (entry: ExerciseEntry, draft: SetDraft) => {
    const bracket = bracketFor(
      entry,
      countFor(entry, draft.setType),
      draft.setType,
    );
    const equipment = equipMap[entry.exercise_id] ?? null;
    const entryMode = resolveLoadEntry({
      override: getExercisePref(entry.exercise_id).loadEntry,
      prescribed: entry.substitutedFor ? null : (bracket?.load_entry ?? null),
      equipment,
      name: entry.name,
    });
    const storedLoad = totalKg(draft.entryKg, entryMode);
    const perSide = entryMode === "per_side";
    const barKg = getExerciseBarKg(entry.exercise_id, unit, equipment);
    const plateSplit =
      equipment === "barbell" || equipment === "machine"
        ? split(storedLoad, barKg, inventory)
        : null;
    const hint = plateSplit
      ? plateSplit.plates.length > 0
        ? plateSplit.plates
            .map(
              (plate) =>
                `${plate.count > 1 ? `${plate.count}×` : ""}${formatPlate(plate.plate, unit)}`,
            )
            .join("·")
        : barKg > 0
          ? "BAR ONLY"
          : "EMPTY"
      : null;
    return {
      entry,
      draft,
      tracking: "reps" as const,
      loadPresentation: {
        perSide,
        totalKg: storedLoad,
        plateSplit,
        barKg,
        hint,
        noLoad: isBodyweightEquipment(equipment) && storedLoad === 0,
        canToggleEntry: offersLoadEntry({
          override: getExercisePref(entry.exercise_id).loadEntry,
          prescribed: entry.substitutedFor
            ? null
            : (bracket?.load_entry ?? null),
          equipment,
          name: entry.name,
        }),
      },
      unit,
      maxEntryKg: perSide ? MAX_LOAD_KG / 2 : MAX_LOAD_KG,
      loadSteps: loadSteps(entry.exercise_id, unit),
      rpeShown: rpeShown(entry.exercise_id),
      logLabel: "unused",
      lastPerformance: lastTime(
        entry.exercise_id,
        true,
        isBodyweightEquipment(equipment) && storedLoad === 0,
        entryMode,
      ),
      disabled: logLocked || !setsLoaded || setsFailed,
      onDraftChange: (next: Partial<SetDraft>) => {
        setRoundDrafts((prior) => ({
          ...prior,
          [entry.key]: { ...roundDraftFor(entry), ...next },
        }));
        setRoundError(null);
      },
      onLog: () => undefined,
      onOpenPlates: () => openSheet("plates", entry.key),
      onOpenPad: (kind: "load" | "reps") => openPad(kind, false, entry.key),
      onToggleLoadEntry: () =>
        setExerciseLoadEntry(
          entry.exercise_id,
          entryMode === "per_side" ? "total" : "per_side",
        ),
      onRevealRpe: () =>
        setRpeAsked((prior) => new Set([...prior, entry.exercise_id])),
    };
  };

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

  const roundInputEntry =
    roundInputKey === null
      ? null
      : (entries.find((entry) => entry.key === roundInputKey) ?? null);
  const roundInputEditor = roundInputEntry
    ? roundEditorFor(roundInputEntry, roundDraftFor(roundInputEntry))
    : null;
  const plateEntry = roundInputEntry ?? openEntry;
  const req = padRequest();
  const sheetOpen =
    sheet !== null || pad !== null || demoFor !== null || moreOpen;
  const inFocusDeck =
    presentation === "focus" && focusEligible && focusEntry !== null;
  // Every set of the whole workout is done — not just the current exercise.
  // The primary action has nothing left to log against, so it becomes the
  // one way out of the workout instead of a button that would only stage an
  // unplanned extra set.
  const workoutDone = entries.length > 0 && entries.every(entryDone);
  const finishWorkout = () => {
    // ending the session ends the rest; nothing to announce
    disarmRestAlert();
    navigate("/end");
  };
  // The rest clock renders INSIDE the hero editor (just above its bottom
  // bar) instead of Session's own fixed strip, but only for the plain,
  // single-entry case that editor actually is — mid-correction or mid-round
  // it reverts to the strip, since neither of those paths has a bottom bar
  // of its own to sit above.
  const restInline = inFocusDeck && !editing && focusSupersetPair === null;
  const restTimerEl = (
    <RestTimer
      rest={rest}
      onAdjust={(d) => {
        if (!rest) return;
        const targetSeconds = Math.max(0, rest.targetSeconds + d);
        setRest({ ...rest, targetSeconds });
        mirrorRest(targetSeconds, rest.forLabel);
        // the closed-app alert follows the target
        armRestAlert(rest.startedAt + targetSeconds * 1000, rest.forLabel);
      }}
      onEdit={() => openPad("rest")}
      /* dismissing hides the strip only: the clock keeps measuring, so
         the mirror keeps its startedAt with a null target — and a strip
         nobody wants to see is a buzz nobody wants either */
      onDone={() => {
        setRest(null);
        mirrorRest(null, null);
        disarmRestAlert();
      }}
    />
  );

  return (
    <div className="session-shell">
      <div
        className="session-scroll"
        style={
          noteEditingId && kbInset > 0 ? { paddingBottom: kbInset } : undefined
        }
      >
        {/* Session notes move to the top of the "more" sheet in focus mode —
            see below — so the default screen stays to the hero and LOG. */}
        {!inFocusDeck && (active.plan_note || active.coach_note) && (
          <div className="session-notes">
            {active.plan_note && (
              <Note label="PLAN NOTE" text={active.plan_note} />
            )}
            {active.coach_note && (
              <Note label="COACH" text={active.coach_note} />
            )}
          </div>
        )}

        <section className={inFocusDeck ? "focus-shell" : "rule-section"}>
          {!inFocusDeck && (
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
          )}

          {inFocusDeck && focusEntry ? (
            <FocusDeck
              entries={entries}
              entry={focusEntry}
              entryProgress={entryProgress}
              entryDone={entryDone}
              onViewFullWorkout={showOverview}
              onChooseNext={(entry) => {
                setFocusKey(entry.key);
                setOpenKey(entry.key);
              }}
              canAdvance={
                !editing &&
                (focusSupersetPair === null ||
                  focusSupersetPair.every(entryDone))
              }
              renderEditor={(entry) => renderEditor(entry, false, "hero")}
              onOpenMore={() => setMoreOpen(true)}
              formatScheme={scheme}
              supersetHeading={focusRoundHeading}
            />
          ) : (
            <>
              {!focusEligible && entries.length > 0 && (
                <p className="microcopy focus-unavailable">
                  Duration tracking is not available in focus mode. This workout
                  stays in the full view.
                </p>
              )}
              <WorkoutOverview
                entries={entries}
                selectedEntryKey={selectedEntryKey}
                expandedEntryKey={openKey}
                onSelectEntry={setSelectedEntryKey}
                onToggleEntry={toggleOpen}
                onEnterFocus={enterFocus}
                focusModeAvailable={focusEligible}
                entryProgress={entryProgress}
                isSkipped={(entry) => skips.has(entry.key)}
                hasSections={hasSections}
                supersetInfo={supersetInfo}
                formatScheme={scheme}
                onOpenDemo={(entry) =>
                  setDemoFor({ id: entry.exercise_id, name: entry.name })
                }
                renderRowAction={(entry) => {
                  const removable =
                    entry.brackets.length === 0 &&
                    setsForEntry(entry).length === 0;
                  const skipped = skips.has(entry.key);
                  return (
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
                  );
                }}
                renderEditor={renderEditor}
              />

              {entries.length === 0 && (
                <p className="microcopy">
                  Nothing planned for this session. Add an exercise to start
                  logging — load and reps prefill from your last time.
                </p>
              )}
              <button
                type="button"
                className="btn btn-outline-ink btn-block"
                onClick={() => openSheet("search")}
              >
                Add exercise
              </button>
            </>
          )}
        </section>
      </div>

      {/* In focus mode, the plain hero editor renders this same timer
          inline, just above its own bottom bar (restSlot) — the fixed strip
          would otherwise duplicate it below a footer that is itself hidden
          there. Mid-correction or mid-round, neither of which has a bottom
          bar of its own to sit above, it falls back to this fixed strip. */}
      {!sheetOpen && !restInline && restTimerEl}

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
          onClick={finishWorkout}
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

      {demoFor && (
        <ExerciseDemoSheet
          exerciseId={demoFor.id}
          exerciseName={demoFor.name}
          onClose={() => setDemoFor(null)}
        />
      )}

      {sheet === "plates" && plateEntry && (
        <PlateSheet
          exerciseId={plateEntry.exercise_id}
          exerciseName={plateEntry.name}
          targetKg={roundInputEditor?.loadPresentation.totalKg ?? totalLoadKg}
          unit={unit}
          equipment={equipMap[plateEntry.exercise_id] ?? null}
          onTypeTarget={() =>
            openPad("load", true, roundInputEntry?.key ?? null)
          }
          onClose={() => {
            setSheet(null);
            setRoundInputKey(null);
          }}
        />
      )}

      {moreOpen && focusEntry && (
        <FocusMoreSheet
          title={
            focusSupersetPair
              ? `SUPERSET ${(supersetInfo.get(focusSupersetPair[0].key)?.tag ?? "A1").replace(/\d+$/, "")} · MORE`
              : `${focusEntry.name.toUpperCase()} · MORE`
          }
          onClose={() => setMoreOpen(false)}
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
          <button
            type="button"
            className="btn btn-outline-ink btn-block"
            onClick={() => {
              setMoreOpen(false);
              finishWorkout();
            }}
          >
            Finish workout
          </button>
          {(focusSupersetPair ?? [focusEntry]).map((target, i) => (
            <div
              key={target.key}
              className="focus-more-section"
              aria-label={
                focusSupersetPair
                  ? `${supersetInfo.get(target.key)?.tag ?? (i === 0 ? "A1" : "A2")} ${target.name} · more`
                  : `${target.name} · more`
              }
            >
              {focusSupersetPair && (
                <div className="focus-more-heading">
                  {supersetInfo.get(target.key)?.tag ?? (i === 0 ? "A1" : "A2")}{" "}
                  · {target.name}
                </div>
              )}
              {renderEditor(target, false, "detail")}
              {moreExtrasFor(target)}
            </div>
          ))}
        </FocusMoreSheet>
      )}

      {req && <NumberPad req={req} />}
    </div>
  );
}
