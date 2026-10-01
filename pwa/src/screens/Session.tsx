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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { type StepDef } from "../components/Stepper";
import { Note } from "../components/Note";
import {
  RestDockTag,
  RestTimer,
  silenceRestCue,
  useRestCue,
  type ActiveRest,
} from "../components/RestTimer";
import { OutboxSheet } from "../components/OutboxSheet";
import {
  SetReceiptStatus,
  RECEIPT_GLYPH,
  receiptKind,
  type ReceiptKind,
} from "../components/session/SetReceiptStatus";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import { PlateSheet } from "../components/PlateSheet";
import {
  SetEditor,
  type SetDraft,
} from "../components/session/SetEditor";
import { DockKeys, FocusDeck, type FocusKeys } from "../components/session/FocusDeck";
import { FocusMoreSheet } from "../components/session/FocusMoreSheet";
import { WorkoutOverview } from "../components/session/WorkoutOverview";
import {
  LoadPicture,
  PlateDiagram,
  type LoadPictureModel,
} from "../components/session/LoadPicture";
import { SupersetRound, type RoundMemberCard } from "../components/session/SupersetRound";
import {
  SessionHeaderControls,
  SessionHeaderPortal,
} from "../components/session/SessionHeader";
import { TodayWorkoutSheet } from "../components/session/TodayWorkoutSheet";
import { RpeSheet } from "../components/session/RpeSheet";
import { NoteSheet } from "../components/session/NoteSheet";
import { CorrectionSheet } from "../components/session/CorrectionSheet";
import { LoggedSetRow } from "../components/session/LoggedSetRow";
import { RestLastSetCard } from "../components/session/RestLastSetCard";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { plateText } from "../lib/loadPicture";
import { buildSetLoad, LoadIntegrityError, typedFromDraft } from "../lib/setLoad";
import { formatSetLine, setPositionLabel } from "../lib/setLine";
import { ExerciseDemoSheet } from "../components/ExerciseDemoSheet";
import { ExercisePicker } from "../components/ExercisePicker";
import { NewExerciseSheet } from "../components/NewExerciseSheet";
import { Sheet } from "../components/Sheet";
import { cacheDelete, cacheGet, cacheSet, cacheKeys } from "../lib/db";
import { readSessionPrefs, writeSessionPrefs } from "../lib/sessionPrefs";
import {
  blockMoveIndex,
  moveSessionEntry,
  orderedEntryBlocks,
  reconcileEntryOrder,
  sessionEntryMoveIndex,
} from "../lib/sessionOrder";
import type { OutboxOp } from "../lib/db";
import {
  getExercises,
  getExactSetReceiptIds,
  getLastActuals,
  getResolvedPrescriptions,
  getServerSessionSets,
  getSetNotesByIds,
  mergeSets,
  type LastActuals,
  type LastActualSet,
} from "../lib/data";
import {
  bracketFor,
  buildEntries,
  isLocalBracket,
  setsForEntry as setsForEntryOf,
  supersetInfo as supersetInfoOf,
  supersetLetter,
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
import { getCurrentUserId, onUserChange } from "../lib/currentUser";
import { readPersistedUserId } from "../lib/persistedSession";
import {
  correctionWaiting,
  projectSetReceipt,
  setQueueHeld,
  type SetReceipt,
} from "../lib/setReceipt";
import type { OutboxEntry } from "../lib/outbox";
import {
  roundPlacement,
  supersetGroupEntries,
  supersetRoundView,
} from "../lib/sessionFocus";
import { uuid } from "../lib/uuid";
import { correctedSet, isNoopCorrection } from "../lib/corrections";
import { getPrefillFallback, prefillSet } from "../lib/prefill";
import { split } from "../lib/plates";
import {
  formatClock,
  formatRepRange,
  formatRxTarget,
  rxHasNoTm,
} from "../lib/format";
import { reportError, toast } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import {
  useAutoStartRest,
  usePlatesOnHand,
  useSetting,
} from "../hooks/useSettings";
import {
  getExerciseBarKg,
  getExercisePref,
  type ExercisePref,
  getExerciseRestSeconds,
  hasExerciseBase,
  MAX_BAR_KG,
  setExerciseBarKg,
  setExerciseLoadEntry,
  setExerciseLoadStyle,
} from "../lib/settings";
import { readSkipsCache, type SkipRecord } from "../lib/skips";
import { useWakeLock } from "../hooks/useWakeLock";
import { unlockRestCue } from "../lib/restCue";
import {
  focusEntryKey,
  isFocusEligible,
  railState,
  transitionPresentation,
  twoMemberSuperset,
  type SessionPresentation,
} from "../lib/sessionFocus";
import type { ProgressState } from "../components/session/StateGlyph";
import { cancelRestAlert, scheduleRestAlert } from "../lib/push";
import {
  enteredKg,
  isBodyweightEquipment,
  offersLoadEntry,
  resolveLoadEntry,
  totalKg,
} from "../lib/loadEntry";
import {
  offersLoadStyle,
  offersLoadStyleSwitch,
  resolveLoadStyle,
  type LoadStyle,
} from "../lib/loadStyle";
import {
  fromDisplay,
  kgToLb,
  stagedDisplayLoad,
  stepKgFor,
  toDisplay,
  type Unit,
} from "../lib/units";
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

type PadKind = "load" | "reps" | "duration" | "rest" | "base";
interface PadSpec {
  kind: PadKind;
  fromPlates?: boolean;
  /** the number being typed belongs to the Fix sheet's own draft */
  forCorrection?: boolean;
}

const LOG_LOCK_MS = 200;
// DB checks: reps between 0 and 100; rest_seconds_actual <= 3600
const MAX_REPS = 100;
const MAX_LOAD_KG = 999;

/** Whose data this device is holding, as far as it can tell right now: the live
 *  identity, else the owner the persisted session names while the live refresh
 *  is still a network call away (the same fallback the outbox stamps with).
 *  It is IDENTITY, NEVER AUTHORIZATION (AGENTS.md): a write is stamped with this
 *  owner and HELD by the flusher if the live owner is different or unknown, and
 *  every request still carries the real token. Null = genuinely unknown. */
function knownOwner(): string | null {
  return getCurrentUserId() ?? readPersistedUserId();
}
const MAX_REST_SECONDS = 3600;

/** A movement with no implement starts at zero load, never at the empty-bar
 *  fallback: in focus mode its load field is hidden, so a 20 kg default would
 *  be logged without anyone seeing it. */
function bodyweightFallback(equipment: string | null) {
  const fallback = getPrefillFallback();
  return isBodyweightEquipment(equipment) ? { ...fallback, loadKg: 0 } : fallback;
}

export function Session() {
  const navigate = useNavigate();
  const deviceUnit = useUnit();
  const autoStartRest = useAutoStartRest();

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
  // "Today's workout", opened from the header's ☰ count.
  const [workoutSheetOpen, setWorkoutSheetOpen] = useState(false);

  // The number the USER types. On a per-side exercise it is one side; the
  // total that reaches `sets.load_kg` is derived at the edges (see
  // lib/loadEntry.ts). Seeded from the configured fallback, never a literal.
  const [entryKg, setEntryKg] = useState(() => getPrefillFallback().loadKg);
  const [reps, setReps] = useState(() => getPrefillFallback().reps);
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [setType, setSetType] = useState<SetType>("working");
  /**
   * The staged rating for the NEXT set. Cleared after every log and on every
   * fresh open: load and reps are sticky because they are a plan that
   * repeats; a rating is an observation of one set, and carrying it forward
   * would invent data nobody stated, silently, on an append-only table. It is
   * set from the RPE sheet (the key shows "RPE 8" once it is).
   */
  const [rpe, setRpe] = useState<number | null>(null);
  const stagedDraftsRef = useRef<Record<string, SetDraft>>({});
  // Drafts the lifter actually CHANGED. `stagedDraftsRef` also holds the
  // untouched prefill of every exercise opened, so counting it made "leave
  // the session" ask about unlogged changes after nothing had been touched.
  const dirtyDraftsRef = useRef(new Set<string>());
  const rememberStagedDraft = (
    entry: ExerciseEntry,
    next: Partial<SetDraft>,
    userEdit = true,
  ) => {
    const key = `${entry.key}:${entry.exercise_id}`;
    const prior = stagedDraftsRef.current[key] ?? {
      entryKg,
      reps,
      setType: setType as BracketKind,
      rpe,
      durationSeconds,
    };
    stagedDraftsRef.current[key] = { ...prior, ...next };
    if (userEdit) dirtyDraftsRef.current.add(key);
  };
  const [logLocked, setLogLocked] = useState(false);
  /** A set is being written to the local queue: the button says Saving… and
   *  cannot be pressed again until the write has settled. */
  const [logSaving, setLogSaving] = useState(false);
  /** True for one `--motion-fast` pulse after a tap lands on the 200 ms
   *  duplicate-LOG lock. The tap did something — it just wasn't a second
   *  insert — and `.is-held` (styles.css) says so instead of the button
   *  silently eating it. */
  const [logHeld, setLogHeld] = useState(false);
  /** A normal set and a superset round have the same durable-local boundary:
   * nothing looks logged until IndexedDB accepted it. Keep the failure next to
   * the controlled draft so the lifter can retry without re-entering values. */
  const [logError, setLogError] = useState<string | null>(null);
  const [roundDrafts, setRoundDrafts] = useState<Record<string, SetDraft>>({});
  /** The member the lifter tapped to log out of order (the partner's warmup,
   *  an A2 first). Cleared by any log; honoured only while that member still
   *  has work to do. */
  const [roundNowOverride, setRoundNowOverride] = useState<string | null>(null);
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);
  const [extraSetArmed, setExtraSetArmed] = useState(false);
  /** Bodyweight movements show added load only once somebody asks for it. */
  const [bwAddOpen, setBwAddOpen] = useState<string | null>(null);
  /** Which paired editor owns the ephemeral pad or plate sheet, if either. */
  const [roundInputKey, setRoundInputKey] = useState<string | null>(null);
  /** The member a Swap was opened FOR; null means the open entry. */
  const [swapKey, setSwapKey] = useState<string | null>(null);

  const [rest, setRest] = useState<ActiveRest | null>(null);
  // survives DONE so the next log can still record elapsed rest
  const restRef = useRef<{ startedAt: number } | null>(null);
  // A setting can change while a rest strip is already visible. Keep the
  // previous value so the effect below acts only on the enabled -> disabled
  // transition, rather than continually re-writing a hidden rest mirror.
  const wasAutoStartRest = useRef(autoStartRest);

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

  const [skips, setSkips] = useState<Record<string, SkipRecord>>({});
  const [voidArm, setVoidArm] = useArmed();
  // The set being CORRECTED, as a draft of its own. A correction is a void
  // plus a new row at the same index (lib/corrections.ts); this is only the
  // screen's side of it. It never borrows the dock's staged values, and it
  // carries the load convention of the exercise the SET belongs to, so what
  // is open when Fix is tapped cannot change what gets written (C1).
  const [editing, setEditing] = useState<{
    set: SetInsert;
    /** the entry that owns the set, for naming it */
    name: string;
    equipment: string | null;
    loadEntry: LoadEntry;
    tracking: "reps" | "time";
    entryKg: number;
    reps: number;
    setType: SetType;
    rpe: number | null;
    /** what the lifter reads in the load card, in the unit it was authored in */
    enteredLoad: number;
    enteredUnit: Unit;
    loadEdited: boolean;
    saving: boolean;
  } | null>(null);
  // A durable write can take longer than a double tap. Lock by original row
  // so correction, quick RPE, and void cannot commit competing operations.
  const pendingSetMutationIdsRef = useRef(new Set<string>());

  // per-set notes (set_id -> note); "" = cleared
  const [setNotes, setSetNotes] = useState<Record<string, string>>({});
  /** the set the Note sheet is open on; always a live row */
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [rpeSheetOpen, setRpeSheetOpen] = useState(false);

  const [dropArm, setDropArm] = useArmed();
  const [sheet, setSheet] = useState<"search" | "swap" | "plates" | "outbox" | null>(null);
  const [receiptReviewReason, setReceiptReviewReason] = useState<string | null>(null);
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
  const [identityOwner, setIdentityOwner] = useState(knownOwner);
  const identityOwnerRef = useRef(identityOwner);
  const identityEpochRef = useRef(0);
  const [identityRevision, setIdentityRevision] = useState(0);
  const applyIdentity = useCallback((id: string | null) => {
    if (identityOwnerRef.current === id) return;
    identityOwnerRef.current = id;
    const nextEpoch = identityEpochRef.current + 1;
    identityEpochRef.current = nextEpoch;
    setIdentityRevision(nextEpoch);
    setIdentityOwner(id);
  }, []);
  useEffect(() => {
    const stop = onUserChange((id) => applyIdentity(id ?? readPersistedUserId()));
    // The auth mirror may change after render but before this passive effect
    // subscribes. Subscribe first, then reconcile its synchronous snapshot so
    // a missed event cannot strand this session behind prefs hydration.
    applyIdentity(knownOwner());
    return stop;
  }, [applyIdentity]);
  const [sessionUnitState, setSessionUnitState] = useState<{
    ownerId: string; sessionId: string; unit: Unit;
  } | null>(null);
  const [sessionEntryOrderState, setSessionEntryOrderState] = useState<{
    ownerId: string; sessionId: string; keys: string[];
  } | null>(null);
  const [orderWritePending, setOrderWritePending] = useState(false);
  const orderWritePendingRef = useRef(false);
  const [pendingEntryWrites, setPendingEntryWrites] = useState(0);
  const [prefsReadyScope, setPrefsReadyScope] = useState<string | null>(null);
  // An unknown owner (no live identity and nothing persisted) does NOT block
  // logging: the session opens on the device unit and the canonical order, and
  // the outbox stamps or holds each write. The scope below is what "ready"
  // means for that state; when the owner arrives the saved choices are read in
  // the background rather than putting the whole screen back behind a spinner.
  const prefsScope = sessionId ? `${identityOwner ?? "unknown"}:${sessionId}` : null;
  const unknownOwnerScope = sessionId ? `unknown:${sessionId}` : null;
  const unit = identityOwner && sessionId &&
      sessionUnitState?.ownerId === identityOwner &&
      sessionUnitState.sessionId === sessionId
    ? sessionUnitState.unit
    : deviceUnit;
  const prefsReady =
    !sessionId ||
    prefsReadyScope === prefsScope ||
    (prefsReadyScope !== null && prefsReadyScope === unknownOwnerScope);
  const inventory = usePlatesOnHand(unit);

  useEffect(() => {
    let cancelled = false;
    const ownerId = identityOwner;
    const requestedSession = sessionId;
    const identityEpoch = identityEpochRef.current;
    const scope = requestedSession ? `${ownerId ?? "unknown"}:${requestedSession}` : null;
    // Keep an already-ready unknown-owner session ready while the owner's saved
    // choices load; any other change of scope (another session, another
    // account) goes back behind the read.
    setPrefsReadyScope((prev) =>
      requestedSession && prev === `unknown:${requestedSession}` ? prev : null,
    );
    if (!ownerId || !requestedSession) {
      setSessionUnitState(null);
      setSessionEntryOrderState(null);
      setPrefsReadyScope(scope);
      return;
    }
    void readSessionPrefs(ownerId, requestedSession).then((prefs) => {
      if (
        cancelled || identityEpochRef.current !== identityEpoch ||
        knownOwner() !== ownerId || sessionIdRef.current !== requestedSession
      ) return;
      setSessionUnitState(prefs.unit ? { ownerId, sessionId: requestedSession, unit: prefs.unit } : null);
      setSessionEntryOrderState(prefs.entryOrder
        ? { ownerId, sessionId: requestedSession, keys: prefs.entryOrder }
        : null);
      setPrefsReadyScope(scope);
    }).catch((error: unknown) => {
      if (
        cancelled || identityEpochRef.current !== identityEpoch ||
        knownOwner() !== ownerId || sessionIdRef.current !== requestedSession
      ) return;
      reportError(error, "read session preferences");
      setSessionUnitState(null);
      setSessionEntryOrderState(null);
      setPrefsReadyScope(scope);
    });
    return () => { cancelled = true; };
  }, [identityOwner, identityRevision, sessionId]);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [receiptSnapshot, setReceiptSnapshot] = useState<{
    sessionId: string | null;
    ownerId: string | null;
    entries: OutboxEntry[];
    correctionLinks: Record<string, string>;
    readError: string | null;
    serverSetIds: ReadonlySet<string>;
    serverVoidIds: ReadonlySet<string>;
  }>({
    sessionId: null, ownerId: null, entries: [], correctionLinks: {}, readError: null,
    serverSetIds: new Set(), serverVoidIds: new Set(),
  });
  const receiptReadVersion = useRef(0);
  const receiptSessionRef = useRef(sessionId);
  receiptSessionRef.current = sessionId;

  const refreshReceiptSnapshot = useCallback(async () => {
    const requestedSession = sessionId;
    const ownerId = knownOwner();
    const version = ++receiptReadVersion.current;
    const isCurrent = () =>
      version === receiptReadVersion.current &&
      receiptSessionRef.current === requestedSession &&
      knownOwner() === ownerId;
    if (!requestedSession) return;

    try {
      const [entries, correctionLinks] = await Promise.all([
        outbox.inspect(),
        outbox.correctionLinks(requestedSession),
      ]);
      if (!isCurrent()) return;
      if (!ownerId) {
        setReceiptSnapshot({
          sessionId: requestedSession, ownerId: null, entries, correctionLinks: {}, readError: null,
          serverSetIds: new Set(), serverVoidIds: new Set(),
        });
        return;
      }

      const ids = new Set<string>();
      for (const set of setsRef.current) {
        if (set.session_id === requestedSession) ids.add(set.id);
      }
      for (const entry of entries) {
        if (entry.user_id !== ownerId && entry.user_id !== undefined) continue;
        if (entry.op.kind === "insert" && entry.op.table === "sets" && entry.op.payload.session_id === requestedSession) {
          ids.add(entry.op.payload.id);
        } else if (entry.op.kind === "insert" && entry.op.table === "set_voids") {
          ids.add(entry.op.payload.set_id);
        }
      }
      for (const [replacementId, originalId] of Object.entries(correctionLinks)) {
        ids.add(replacementId);
        ids.add(originalId);
      }

      // The queue is local and already known: show it NOW, before the network
      // read returns, so a set that was just enqueued says "On this phone"
      // rather than "Needs review". Entries the new read no longer lists stay
      // until the exact read lands, so an ACK cannot flash review either.
      setReceiptSnapshot((previous) => {
        const sameScope = previous.sessionId === requestedSession && previous.ownerId === ownerId;
        const known = new Set(entries.map((entry) => entry.key));
        return {
          sessionId: requestedSession, ownerId,
          entries: sameScope ? [...entries, ...previous.entries.filter((entry) => !known.has(entry.key))] : entries,
          correctionLinks: sameScope ? { ...previous.correctionLinks, ...correctionLinks } : correctionLinks,
          readError: sameScope ? previous.readError : null,
          serverSetIds: sameScope ? previous.serverSetIds : new Set(),
          serverVoidIds: sameScope ? previous.serverVoidIds : new Set(),
        };
      });

      try {
        const exact = await getExactSetReceiptIds(requestedSession, ownerId, [...ids]);
        if (!isCurrent()) return;
        setReceiptSnapshot((previous) => {
          const sameScope = previous.sessionId === requestedSession && previous.ownerId === ownerId;
          return {
            sessionId: requestedSession, ownerId, entries,
            // Queue relations are immutable for a session. Keep one already
            // observed while an older, empty snapshot resolves after an ACK.
            correctionLinks: sameScope ? { ...previous.correctionLinks, ...correctionLinks } : correctionLinks,
            readError: null,
            // Exact UUID evidence is append-only. A successful empty result
            // cannot revoke a prior successful ACK or readback.
            serverSetIds: new Set([...(sameScope ? previous.serverSetIds : []), ...exact.setIds]),
            serverVoidIds: new Set([...(sameScope ? previous.serverVoidIds : []), ...exact.voidIds]),
          };
        });
      } catch (error) {
        if (!isCurrent()) return;
        reportError(error, "read exact set receipt evidence");
        const readError = error instanceof Error ? error.message : String(error);
        setReceiptSnapshot((previous) => {
          const sameScope = previous.sessionId === requestedSession && previous.ownerId === ownerId;
          return {
            sessionId: requestedSession, ownerId, entries,
            correctionLinks: sameScope ? { ...previous.correctionLinks, ...correctionLinks } : correctionLinks,
            readError,
            serverSetIds: sameScope ? previous.serverSetIds : new Set(),
            serverVoidIds: sameScope ? previous.serverVoidIds : new Set(),
          };
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      reportError(error, "refresh set receipt queue snapshot");
    }
  }, [sessionId]);

  const receiptForSet = useCallback((setId: string): SetReceipt => {
    const ownerId = knownOwner();
    if (!ownerId || receiptSnapshot.ownerId !== ownerId || receiptSnapshot.sessionId !== sessionId) {
      return { state: "review", reason: "The set owner or session is not confirmed on this device." };
    }
    const receipt = projectSetReceipt({
      setId, ownerId,
      serverSetIds: receiptSnapshot.serverSetIds,
      serverVoidIds: receiptSnapshot.serverVoidIds,
      entries: receiptSnapshot.entries,
      correctionOf: receiptSnapshot.correctionLinks[setId],
    });
    const readFailureMayExplain = receipt.reason === "No exact server or queued operation confirms this set." ||
      receipt.reason === "Exact replacement and original void evidence is incomplete." ||
      receipt.reason === "The void is confirmed, but the set row was not read back.";
    return receipt.state === "review" && receiptSnapshot.readError && readFailureMayExplain
      ? { ...receipt, reason: `Could not verify exact server receipt: ${receiptSnapshot.readError}` }
      : receipt;
  }, [receiptSnapshot, sessionId]);

  const openReceiptReview = (receipt: SetReceipt) => {
    if (receipt.state !== "review") return;
    setReceiptReviewReason(receipt.reason ?? "Exact server confirmation is missing.");
    setSheet("outbox");
  };

  useEffect(() => {
    if (!sessionId) return;
    const refresh = () => { void refreshReceiptSnapshot(); };
    const stopQueue = outbox.subscribe(refresh);
    const stopSynced = outbox.subscribeSynced((op: OutboxOp, ownerId, correctionLink) => {
      if (!ownerId || ownerId !== knownOwner() || receiptSessionRef.current !== sessionId) return;
      let setId: string | null = null;
      let isVoid = false;
      if (op.kind === "insert" && op.table === "sets" && op.payload.session_id === sessionId) {
        setId = op.payload.id;
      } else if (
        op.kind === "insert" && op.table === "set_voids" &&
        correctionLink?.session_id === sessionId &&
        correctionLink.original_id === op.payload.set_id
      ) {
        setId = correctionLink.original_id;
        isVoid = true;
      }
      if (setId) {
        setReceiptSnapshot((previous) => {
          if ((previous.sessionId !== null && previous.sessionId !== sessionId) ||
              (previous.ownerId !== null && previous.ownerId !== ownerId)) return previous;
          const sameScope = previous.sessionId === sessionId && previous.ownerId === ownerId;
          const correctionLinks = sameScope ? { ...previous.correctionLinks } : {};
          if (correctionLink?.session_id === sessionId) {
            correctionLinks[correctionLink.replacement_id] = correctionLink.original_id;
          }
          return {
            ...previous, sessionId, ownerId, correctionLinks,
            entries: sameScope ? previous.entries : [],
            serverSetIds: isVoid ? (sameScope ? previous.serverSetIds : new Set()) : new Set([...(sameScope ? previous.serverSetIds : []), setId!]),
            serverVoidIds: isVoid ? new Set([...(sameScope ? previous.serverVoidIds : []), setId!]) : (sameScope ? previous.serverVoidIds : new Set()),
          };
        });
      }
      refresh();
    });
    const stopIdentity = onUserChange(() => {
      receiptReadVersion.current += 1;
      setReceiptSnapshot({
        sessionId, ownerId: null, entries: [], correctionLinks: {}, readError: null,
        serverSetIds: new Set(), serverVoidIds: new Set(),
      });
      refresh();
    });
    refresh();
    return () => {
      receiptReadVersion.current += 1;
      stopQueue();
      stopSynced();
      stopIdentity();
    };
  }, [sessionId, refreshReceiptSnapshot]);

  useEffect(() => {
    if (setsLoaded) void refreshReceiptSnapshot();
  }, [sets, setsLoaded, refreshReceiptSnapshot]);

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
          cacheGet<string[] | Record<string, SkipRecord>>(
            cacheKeys.sessionSkips(a.id),
          ),
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
        setSkips(readSkipsCache(skipsCached));
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

  useEffect(() => {
    const wasEnabled = wasAutoStartRest.current;
    wasAutoStartRest.current = autoStartRest;
    if (!wasEnabled || autoStartRest) return;

    // Turning automatic rest off is an instruction about the currently
    // visible cue too. Preserve the measuring clock in restRef so the next
    // set still records actual rest, but remove this stale strip, its mirror
    // target, and its closed-app alert immediately.
    setRest(null);
    disarmRestAlert();
    mirrorRest(null, null);
  }, [autoStartRest, mirrorRest]);

  // ---- exercise entries ----------------------------------------------------

  const knownRxIds = useMemo(() => new Set(rx.map((r) => r.id)), [rx]);

  // ramps collapsed, extras appended, orphan sets given a home — see
  // lib/entries.ts, where the rules are pure and unit-tested
  const entries: ExerciseEntry[] = useMemo(
    () => buildEntries(rx, extras, sets, allExercises, subs),
    [rx, extras, sets, allExercises, subs],
  );
  const savedEntryOrder =
    prefsReady && sessionEntryOrderState?.ownerId === identityOwner &&
      sessionEntryOrderState.sessionId === sessionId
      ? sessionEntryOrderState.keys
      : undefined;
  const orderedEntries = useMemo(
    () => savedEntryOrder ? reconcileEntryOrder(entries, savedEntryOrder) : entries,
    [entries, savedEntryOrder],
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

  /** The newest live set among these, by when it was done: corrections keep
   *  `performed_at`, so a replacement takes its original's place, and a voided
   *  row is not in `sets` at all. */
  const newestOf = (list: readonly SetInsert[]): SetInsert | null =>
    list.reduce<SetInsert | null>(
      (a, b) =>
        a === null ||
        b.performed_at > a.performed_at ||
        (b.performed_at === a.performed_at && b.set_index > a.set_index)
          ? b
          : a,
      null,
    );

  /** The last set saved, whatever it was — derived from the live rows, never
   *  held as a copy. After a correction it IS the replacement, so the LAST SET
   *  card, "Fix last" and the Note key can never point at a voided row (C2). */
  const lastSet = useMemo(() => newestOf(sets), [sets]);

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
      e.key in skips || entryMet(e, setsForEntry(e)),
    [skips, setsForEntry],
  );
  const doneEntries = entries.filter(entryDone).length;
  const focusEligible = isFocusEligible(orderedEntries);
  const overviewOnlyCircuit = orderedEntries
    .map((entry) => supersetGroupEntries(orderedEntries, entry.key))
    .find((members) => members.length > 2) ?? null;
  const selectedFocusEntry =
    orderedEntries.find((entry) => entry.key === focusKey) ?? openEntry;
  const selectedFocusPair = useMemo(
    () => twoMemberSuperset(orderedEntries, selectedFocusEntry?.key ?? null),
    [orderedEntries, selectedFocusEntry?.key],
  );
  const focusSupersetPair =
    selectedFocusPair !== null && !selectedFocusPair.every(entryDone)
      ? selectedFocusPair
      : null;
  // Selecting A2 in overview still opens the pair from its canonical first
  // member. A round is one unit of work, not two independently focused cards.
  const focusEntry = focusSupersetPair?.[0] ?? selectedFocusEntry;

  // The live superset round, member by member: which member the dock edits
  // and logs (NOW), the state of both cards, and "round 2 of 4". One question,
  // answered once (lib/sessionFocus.ts), so the card, the dock label, the
  // heading and the rest decision can never disagree. A SKIPPED member counts
  // as finished, so the partner is NOW and can be logged (H1).
  const roundView = useMemo(() => {
    if (!focusSupersetPair) return null;
    const progressOf = (e: ExerciseEntry) => ({
      progress: entryProgress(e),
      target: targetSets(e),
      skipped: e.key in skips,
    });
    const override =
      roundNowOverride === focusSupersetPair[0].key
        ? 0
        : roundNowOverride === focusSupersetPair[1].key
          ? 1
          : null;
    return supersetRoundView(
      progressOf(focusSupersetPair[0]),
      progressOf(focusSupersetPair[1]),
      override,
    );
  }, [focusSupersetPair, entryProgress, skips, roundNowOverride]);
  /** the entry the dock is editing: the round's NOW member, else the focus
   *  entry */
  const nowEntry =
    roundView && focusSupersetPair
      ? focusSupersetPair[roundView.nowIndex]
      : focusEntry;

  // One state per entry, from the shared vocabulary (StateGlyph.tsx),
  // feeding the Today's workout rows and the List so the surfaces can never
  // describe the same entry two different ways.
  const currentKeys = useMemo(
    () => new Set(nowEntry ? [nowEntry.key] : []),
    [nowEntry],
  );
  const entryState = useCallback(
    (e: ExerciseEntry): ProgressState =>
      railState(
        orderedEntries,
        e,
        currentKeys,
        (x) => Boolean(skips[x.key]),
        entryDone,
      ),
    [orderedEntries, currentKeys, skips, entryDone],
  );

  // default open: first incomplete entry, once, AFTER sets have merged —
  // otherwise a mid-workout reload opens exercise 1 instead of where the
  // user actually is
  const defaultOpened = useRef(false);
  useEffect(() => {
    if (!setsLoaded || !prefsReady || defaultOpened.current || orderedEntries.length === 0) return;
    defaultOpened.current = true;
    setOpenKey(orderedEntries.find((e) => !entryDone(e))?.key ?? null);
  }, [setsLoaded, prefsReady, orderedEntries, entryDone]);

  // Decided once per session start/restore, from the canonical entries this
  // session actually has — never persisted, so a reload always re-derives it
  // rather than promising to restore a visual mode nobody saved.
  const focusPresentationStarted = useRef(false);
  // A tap on Focus or List before the session finished loading is a choice:
  // the default below must not overwrite it a moment later.
  const viewPickedByUser = useRef(false);
  useEffect(() => {
    if (!setsLoaded || !prefsReady || focusPresentationStarted.current) return;
    focusPresentationStarted.current = true;
    if (viewPickedByUser.current) return;
    if (!focusEligible) {
      setPresentation("overview");
      return;
    }
    const key = focusEntryKey(orderedEntries, entryDone, openKey);
    setFocusKey(key);
    setOpenKey(key);
    setPresentation("focus");
  }, [orderedEntries, entryDone, focusEligible, openKey, setsLoaded, prefsReady]);

  // The "more" sheet describes ONE exercise (or round); switching what focus
  // is showing under it — by advancing, or by leaving focus altogether —
  // must not leave it open describing something no longer on screen.
  useEffect(() => {
    setMoreOpen(false);
  }, [openKey, presentation]);

  // superset grouping: consecutive entries sharing a non-null group get
  // A1/A2 tags and a bracket rail
  const supersetInfo = useMemo(() => supersetInfoOf(orderedEntries), [orderedEntries]);

  // The focus deck's own header, for the one case it isn't just the
  // exercise name: a live round replaces "Romanian Deadlift / SET 1 OF 3"
  // with "Superset A" / "round 1 of 3" so the two member names underneath
  // are never named twice on one screen.
  const focusRoundHeading =
    presentation === "focus" && roundView !== null && focusSupersetPair !== null
      ? {
          title: `Superset ${(supersetInfo.get(focusSupersetPair[0].key)?.tag ?? "A1").replace(/\d+$/, "")}`,
          subtitle:
            roundView.roundTotal > 0
              ? `round ${roundView.roundIndex} of ${roundView.roundTotal}`
              : `round ${roundView.roundIndex}`,
        }
      : null;

  /** Does this day have any named part? If not, it needs no headings at all. */
  const hasSections = useMemo(
    () => orderedEntries.some((e) => (e.brackets[0]?.section ?? null) !== null),
    [orderedEntries],
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
    const idx = orderedEntries.findIndex((e) => e.key === openEntry.key);
    return orderedEntries.slice(idx + 1).find((e) => !entryDone(e)) ?? null;
  }, [openEntry, orderedEntries, entryDone]);

  // Mid-superset the round, not the list, is what comes next: after A1 you
  // do A2, and `nextEntry` above never helps because it only appears once
  // the OPEN entry is finished, which mid-round it never is. So every log in
  // a superset offered nothing, and the lifter scrolled back up and tapped
  // the partner by hand — every round, of every superset, of every session.
  const partnerEntry = useMemo(
    () => supersetPartnerOf(orderedEntries, openKey, entryDone),
    [orderedEntries, openKey, entryDone],
  );

  // The partner leads while the round is unfinished; once it is, the
  // ordinary next-exercise hint takes over. Exactly one destination, so the
  // secondary button never has to be read twice.
  const advanceTo = partnerEntry ?? nextEntry;

  // ---- helpers every surface shares ----------------------------------------
  //
  // Defined once, ahead of anything that renders, so the Focus dock, the List
  // card, a superset member, the Fix sheet and the rest scene all read an
  // exercise the same way (and none of them can be handed another exercise's
  // convention).

  // Every exercise's preference (synced to the account), subscribed as a whole: a toggle
  // made on a superset's OTHER member (its dumbbell count, its sled weight)
  // must re-render this screen, which a per-exercise hook on the open entry
  // would never notice.
  const prefs = useSetting("exercisePrefs");
  const outboxStatus = useOutboxStatus();
  const prefFor = (exerciseId: string): ExercisePref => prefs[exerciseId] ?? {};

  /** A movement logged by ticking it off rather than by weight and reps. */
  const isTick = (entry: ExerciseEntry | null): boolean =>
    entry?.brackets[0]?.tracking === "done";
  const isTimed = (entry: ExerciseEntry | null): boolean =>
    entry?.brackets[0]?.tracking === "time";
  const trackingOf = (entry: ExerciseEntry): "reps" | "done" | "time" =>
    isTick(entry) ? "done" : isTimed(entry) ? "time" : "reps";

  /** "1×8-15 @ 90 KG · 3×3-5" — an entry's full prescribed scheme. */
  const scheme = (entry: ExerciseEntry): string =>
    entry.brackets
      .map((b) => {
        // Tick prescriptions encode reps as zero because there is no numeric
        // rep target. Quoting the shared rep formatter directly turned that
        // implementation value into a false "3×0" target in List.
        if (b.tracking === "done") return `${b.sets}×done`;
        if (b.tracking === "time") return `${b.sets}×time`;
        const loadEntry = resolveLoadEntry({
          override: prefFor(entry.exercise_id).loadEntry,
          prescribed: entry.substitutedFor ? null : (b.load_entry ?? null),
          equipment: equipMap[entry.exercise_id] ?? null,
          name: entry.name,
        });
        return formatRxTarget({ ...b, load_entry: loadEntry }, unit);
      })
      .join(" · ");

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

  /**
   * "Last time · 60 kg × 8, 8, 6" — the previous SESSION's working sets for
   * this movement, in the convention given.
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
    entryMode: LoadEntry,
    latestOnly = false,
    repsOnly = false,
  ): string | null => {
    const a = lastActuals[exerciseId];
    if (!a) return null;
    // What was typed comes back as typed (same unit, same convention);
    // anything else is the one-decimal conversion of the stored total.
    const shown = (set: LastActualSet) => {
      const typedHere =
        set.entered_load != null &&
        set.entered_unit === unit &&
        (set.load_entry ?? null) === entryMode;
      const value = typedHere
        ? set.entered_load
        : toDisplay(enteredKg(set.load_kg, entryMode), unit);
      return `${value} ${unit}${entryMode === "per_side" ? "/side" : ""}`;
    };
    if (latestOnly)
      return repsOnly
        ? `Last time · ${a.reps} reps`
        : `Last time · ${shown(a)} × ${a.reps}`;
    // a value cached before runs existed carries only the top set
    const run = a.run && a.run.length > 0 ? a.run : [a];
    const sameLoad = run.every((s) => s.load_kg === run[0].load_kg);
    const body = sameLoad
      ? `${shown(run[0])} × ${run.map((s) => s.reps).join(", ")}`
      : run.map((s) => `${shown(s)} × ${s.reps}`).join(" · ");
    return `Last time · ${body}`;
  };

  // ---- navigation ----------------------------------------------------------

  /** Make this exercise the one on screen, in whichever view is showing. */
  const jumpToEntry = (entry: ExerciseEntry) => {
    setFocusKey(entry.key);
    setOpenKey(entry.key);
    setSelectedEntryKey(entry.key);
    setRoundNowOverride(null);
    setExtraSetArmed(false);
  };

  const showOverview = () => {
    viewPickedByUser.current = true;
    priorFocusKey.current = openKey;
    const current = focusKey ?? openKey ?? selectedEntryKey;
    setSelectedEntryKey(current);
    setOpenKey(current);
    setPresentation("overview");
  };

  const enterFocus = () => {
    viewPickedByUser.current = true;
    if (!focusEligible) return;
    const next = transitionPresentation(
      presentation,
      "focus",
      selectedEntryKey,
      openKey,
    );
    const key = next.focusKey ?? focusEntryKey(orderedEntries, entryDone, openKey);
    setOpenKey(key);
    setFocusKey(key);
    setPresentation(next.presentation);
  };

  // ---- today's order -------------------------------------------------------

  // The movable units (whole blocks) in the order shown. What may move, and
  // where, is lib/sessionOrder.ts's decision; this only asks and applies.
  const blocks = useMemo(
    () =>
      orderedEntryBlocks(
        entries,
        orderedEntries.map((entry) => entry.key),
      ),
    [entries, orderedEntries],
  );
  const reorderLocked =
    !prefsReady ||
    // the order is saved per owner, so it waits for one
    !identityOwner ||
    editing !== null ||
    logLocked ||
    logSaving ||
    pendingEntryWrites > 0 ||
    orderWritePending;
  const canMoveBlock = (index: number, direction: "up" | "down"): boolean => {
    const key = blocks[index]?.[0]?.key;
    return (
      key !== undefined &&
      sessionEntryMoveIndex(
        entries,
        key,
        direction,
        orderedEntries.map((entry) => entry.key),
      ) !== null
    );
  };
  const persistEntryOrder = async (keys: string[]) => {
    const ownerId = knownOwner();
    const requestedSession = sessionId;
    if (!ownerId || !requestedSession) return;
    const identityEpoch = identityEpochRef.current;
    const isCurrent = () =>
      identityEpochRef.current === identityEpoch &&
      knownOwner() === ownerId &&
      sessionIdRef.current === requestedSession;
    setSessionEntryOrderState({ ownerId, sessionId: requestedSession, keys });
    orderWritePendingRef.current = true;
    setOrderWritePending(true);
    try {
      await writeSessionPrefs(ownerId, requestedSession, { entryOrder: keys }, isCurrent);
    } catch (error) {
      reportError(error, "save session order");
      if (isCurrent()) toast("Workout order may reset after reload");
    } finally {
      orderWritePendingRef.current = false;
      setOrderWritePending(false);
    }
  };
  /** Move the block at `fromBlock` to `toBlock`. Returns false when the order
   *  rules refuse (it would split a section or superset) or nothing would
   *  change, so the sheet can say so. */
  const moveBlock = (fromBlock: number, toBlock: number): boolean => {
    if (reorderLocked || orderWritePendingRef.current) return false;
    const key = blocks[fromBlock]?.[0]?.key;
    if (key === undefined || !knownOwner() || !sessionId) return false;
    const currentKeys = orderedEntries.map((entry) => entry.key);
    const next = moveSessionEntry(
      entries,
      key,
      blockMoveIndex(blocks, fromBlock, toBlock),
      currentKeys,
    );
    const keys = next.map((entry) => entry.key);
    if (keys.every((entryKey, index) => entryKey === currentKeys[index])) return false;
    void persistEntryOrder(keys);
    return true;
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
  const inputUnit = unit;
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

  // ---- how an exercise is loaded -------------------------------------------

  /**
   * Everything a surface needs to know about HOW this exercise is loaded,
   * for the draft shown: the convention (per hand or total), the plates or
   * stack, the base weight, the caps. A pure read — handlers are attached
   * later, where the sheets exist — and keyed by the entry it is given, never
   * by whichever one is open, so a superset's other member and the Fix sheet
   * ask the same question and get that exercise's own answer.
   *
   * `entryKg` in a draft is what the lifter TYPES: one side on a per-side
   * movement. The total that reaches `sets.load_kg` is derived at the edges
   * (see lib/loadEntry.ts); the base weight only changes how plates are
   * worked out, never the logged load.
   */
  const viewFor = (entry: ExerciseEntry, draft: SetDraft) => {
    const equip = equipMap[entry.exercise_id] ?? null;
    const pref = prefFor(entry.exercise_id);
    const kind: BracketKind = draft.setType === "warmup" ? "warmup" : "working";
    const bracket = bracketFor(entry, countFor(entry, kind), kind);
    const input = {
      override: pref.loadEntry,
      // The coach's convention describes the movement the coach named. A cable
      // stack is a total; the pair of dumbbells standing in for it is not, and
      // inheriting "total" from the prescription would store one hand's weight
      // as the whole system load. Dropped on a swap so the chain falls through
      // to this exercise's own equipment, which is what actually got lifted.
      prescribed: entry.substitutedFor ? null : (bracket?.load_entry ?? null),
      equipment: equip,
      name: entry.name,
    };
    const mode: LoadEntry = resolveLoadEntry(input);
    const perSideMode = mode === "per_side";
    const totalLoadKg = totalKg(draft.entryKg, mode);
    const styleEligible =
      equip === "barbell" || offersLoadStyle(equip, entry.name);
    const style: LoadStyle | null = styleEligible
      ? resolveLoadStyle(pref.loadStyle, equip, entry.name)
      : null;
    const baseKg = getExerciseBarKg(entry.exercise_id, unit, equip);
    const bodyweight = isBodyweightEquipment(equip);
    const lowerEquip = equip?.toLowerCase() ?? "";
    return {
      equipment: equip,
      bracket,
      mode,
      perSide: perSideMode,
      canToggleEntry: offersLoadEntry(input),
      totalLoadKg,
      // the total is what the column caps, so a per-side entry caps at half
      maxEntryKg: perSideMode ? MAX_LOAD_KG / 2 : MAX_LOAD_KG,
      bodyweight,
      /** no implement and nothing staged: reps are the only number */
      noLoad: bodyweight && draft.entryKg === 0,
      style,
      baseKg,
      baseKnown: hasExerciseBase(entry.exercise_id, equip),
      baseName: (equip === "barbell" ? "Bar" : "Sled") as "Bar" | "Sled",
      plateSplit:
        style === "plates" ? split(totalLoadKg, baseKg, inventory, unit) : null,
      canSwitchStyle: offersLoadStyleSwitch(equip, entry.name, pref.loadStyle),
      bellWord: (lowerEquip === "dumbbell"
        ? "dumbbell"
        : lowerEquip.startsWith("kettlebell")
          ? "kettlebell"
          : null) as "dumbbell" | "kettlebell" | null,
    };
  };

  // The dock's draft for the entry being edited at the top level (the open
  // entry): the staged values plus the authored number they were typed as.
  const currentDraft = openEntry
    ? stagedDraftsRef.current[`${openEntry.key}:${openEntry.exercise_id}`]
    : undefined;
  const openDraft: SetDraft = {
    entryKg,
    reps,
    setType: setType as BracketKind,
    rpe,
    durationSeconds,
    enteredLoad: currentDraft?.enteredLoad,
    enteredUnit: currentDraft?.enteredUnit,
  };
  const openView = openEntry ? viewFor(openEntry, openDraft) : null;
  // The open entry's convention and equipment, which the prefill effect and
  // the staged-load display read.
  const equipment = openView?.equipment ?? null;
  const loadEntry: LoadEntry = openView?.mode ?? "total";
  const perSide = loadEntry === "per_side";
  const displayedLoad = stagedDisplayLoad(
    entryKg,
    currentDraft?.enteredLoad,
    currentDraft?.enteredUnit,
    inputUnit,
  );

  /** Flip the convention for an exercise, saved with the exercise's prefs (synced to the account) beside its
   *  bar and increment. The number on screen deliberately does NOT move: it is
   *  what is written on the implement, and only the count of implements
   *  changed. */
  const toggleLoadEntryFor = (entry: ExerciseEntry, mode: LoadEntry) => {
    setExerciseLoadEntry(entry.exercise_id, mode === "per_side" ? "total" : "per_side");
  };

  /** Flip plates <-> stack for an exercise, saved with its prefs (synced to the account). Offered
   *  only where a plate-loaded alternative plausibly exists. */
  const toggleLoadStyleFor = (entry: ExerciseEntry, style: LoadStyle | null) => {
    setExerciseLoadStyle(entry.exercise_id, style === "plates" ? "stack" : "plates");
  };

  const prefilledFor = useRef<string | null>(null);
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    // wait for the sets merge: a mid-workout reload otherwise prefills from
    // the wrong bracket and can clobber staged values while a sheet is open.
    // A correction has a draft of its own (see `editing`), so nothing about
    // staging the next set can overwrite the set being fixed.
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
      setDurationSeconds(stagedDraft.durationSeconds ?? 60);
      return;
    }
    const bracket = fresh ? openingBracket : currentBracket;
    const key = fresh
      ? `${openEntry.key}:${openEntry.exercise_id}:${bracket?.id ?? "free"}:${openingKind}`
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
        ? {
            load_kg: lastThis.load_kg,
            reps: lastThis.reps,
            load_entry: lastThis.load_entry,
            entered_load: lastThis.entered_load,
            entered_unit: lastThis.entered_unit,
          }
        : null,
      lastSession: lastActuals[openEntry.exercise_id] ?? null,
    }, bodyweightFallback(equipment));
    // every source above is a TOTAL; the steppers hold what gets typed
    const sourceEntryKg = bracket?.entered_load != null && bracket.entered_unit
      ? Math.round(fromDisplay(bracket.entered_load, bracket.entered_unit) * 100) / 100
      : Math.round(enteredKg(p.loadKg, loadEntry) * 100) / 100;
    const authoredInDisplayUnit = bracket?.entered_load != null && bracket.entered_unit === unit;
    // An earlier set typed in this unit and convention comes back as typed.
    const repeatTyped =
      p.entered && p.entered.unit === unit && p.entered.entry === loadEntry
        ? p.entered.load
        : undefined;
    const prefilledLoad = authoredInDisplayUnit
      ? sourceEntryKg
      : repeatTyped !== undefined
        ? Math.round(fromDisplay(repeatTyped, unit) * 100) / 100
        : Math.round(fromDisplay(toDisplay(sourceEntryKg, unit), unit) * 100) / 100;
    setEntryKg(prefilledLoad);
    setReps(p.reps);
    stagedDraftsRef.current[draftKey] = {
      entryKg: prefilledLoad,
      reps: p.reps,
      // a freshly opened entry takes its type from ITS plan, never from the
      // toggle another exercise left behind
      setType: fresh ? openingKind : stagedKind,
      rpe: fresh ? null : rpe,
      durationSeconds,
      enteredLoad: authoredInDisplayUnit ? bracket?.entered_load ?? undefined : repeatTyped,
      enteredUnit: authoredInDisplayUnit || repeatTyped !== undefined ? unit : undefined,
    };
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
    unit,
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

  /** Anything the lifter has typed or tapped that is not yet a logged set. The
   *  untouched prefill of an exercise does not count: asking "discard your
   *  unlogged changes?" after nothing was changed is a false alarm. */
  const hasUnloggedChanges = () =>
    dirtyDraftsRef.current.size > 0 ||
    Object.keys(roundDrafts).length > 0 ||
    editing !== null;

  const goHome = () => {
    if (hasUnloggedChanges()) setLeavePromptOpen(true);
    else navigate("/");
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
    // lib/setLoad.ts is the only place load_kg and its authored pair are
    // derived: from what was typed, never from kg plus a separate guess.
    const typed = typedFromDraft(draft, unit);
    const tick = isTick(entry);
    const load = tick
      ? { load_kg: 0, load_entry: "total" as const, entered_load: null, entered_unit: null }
      : buildSetLoad({ typedValue: typed.value, typedUnit: typed.unit, loadEntry: entryMode, maxTotalKg: MAX_LOAD_KG });
    const timed = entry.brackets[0]?.tracking === "time";
    return {
      id: uuid(),
      session_id: sessionId as string,
      exercise_id: entry.exercise_id,
      prescription_id: isLocalBracket(bracket?.id)
        ? null
        : (bracket?.id ?? null),
      set_index: index,
      set_type: draft.setType,
      load_kg: load.load_kg,
      reps: tick || timed ? 0 : draft.reps,
      performed_at: new Date().toISOString(),
      rest_seconds_actual: actualRest,
      load_entry: load.load_entry,
      entered_load: load.entered_load,
      entered_unit: load.entered_unit,
      rpe: tick ? null : draft.rpe,
      duration_seconds: timed ? Math.round(draft.durationSeconds ?? 60) : null,
    };
  };

  const setIndexFor = (exerciseId: string): number =>
    setsRef.current
      .filter((set) => set.exercise_id === exerciseId)
      .reduce((max, set) => Math.max(max, set.set_index), -1) + 1;

  const logSet = async (
    loggedDraft: SetDraft = {
      entryKg,
      reps,
      setType: setType as BracketKind,
      rpe,
      durationSeconds,
      enteredLoad: openEntry
        ? stagedDraftsRef.current[`${openEntry.key}:${openEntry.exercise_id}`]?.enteredLoad
        : undefined,
      enteredUnit: openEntry
        ? stagedDraftsRef.current[`${openEntry.key}:${openEntry.exercise_id}`]?.enteredUnit
        : undefined,
    },
    entryToLog: ExerciseEntry | null = openEntry,
  ): Promise<boolean> => {
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
    if (!entryToLog || !sessionId || logLocked || !setsLoaded || !prefsReady || setsFailed)
      return false;
    setLogLocked(true);
    setLogSaving(true);

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

    // Where this set falls in a superset round, from what is logged BEFORE it.
    // A superset is done a member at a time (A1, then A2, then rest); the gap
    // between the two halves of a round is not a rest, so the second member
    // records an UNKNOWN rest rather than the time since its partner (H3: that
    // number would be stored on an append-only row for good), and rest begins
    // only once the round is complete.
    const kind: BracketKind = loggedDraft.setType === "warmup" ? "warmup" : "working";
    const pair = twoMemberSuperset(orderedEntries, entryToLog.key);
    const partner = pair
      ? pair[0].key === entryToLog.key
        ? pair[1]
        : pair[0]
      : null;
    const placement = roundPlacement(
      {
        progress:
          kind === "warmup" ? warmupCount(entryToLog) : entryProgress(entryToLog),
      },
      partner === null
        ? null
        : kind === "warmup"
          ? {
              progress: warmupCount(partner),
              finished:
                partner.key in skips || warmupCount(partner) >= warmupSets(partner),
            }
          : { progress: entryProgress(partner), finished: entryDone(partner) },
    );

    try {
      const set = buildSetInsert(
        entryToLog,
        loggedDraft,
        bracket,
        targetLoadEntry,
        nextIndex,
        placement.secondOfRound ? null : recordableRest(),
      );
      // The outbox is the only durable local copy while offline. A regular
      // set used to update React first and fire this write in the background,
      // so a rejected IndexedDB transaction produced a convincing but false
      // LOGGED state. Every set — each superset member included — is its own
      // durable write.
      await outbox.enqueue({ kind: "insert", table: "sets", payload: set });

      setVoidArm(null);
      const draftKey = `${entryToLog.key}:${entryToLog.exercise_id}`;
      delete stagedDraftsRef.current[draftKey];
      dirtyDraftsRef.current.delete(draftKey);
      setRoundNowOverride(null);
      // Logging on a skipped exercise means it happened after all, but only
      // after the set has a durable local record.
      if (skips[entryToLog.key]) {
        const unskipped = { ...skips };
        delete unskipped[entryToLog.key];
        persistSkips(unskipped);
      }
      const next = applySets((prev) => [...prev, set]);
      setLogError(null);
      cacheSet(cacheKeys.sessionSets(sessionId), next).catch((e: unknown) =>
        reportError(e, "cache session sets"),
      );

      // Done-ness read from the list that now INCLUDES this set: `sets` state
      // is a render behind, and both decisions below are about the workout as
      // it stands after the tap.
      const doneAfter = (e: ExerciseEntry): boolean =>
        // logging on a skipped exercise un-skips it (above), so the open entry
        // is never treated as skipped here
        (e.key in skips && e.key !== entryToLog.key) ||
        entryMet(e, setsForEntryOf(e, next, rx, knownRxIds));
      // Mid-superset the next thing to do is the partner, not a wait and not
      // the next exercise: only a finished pair hands on.
      const roundOpen = supersetPartnerOf(orderedEntries, entryToLog.key, doneAfter);
      if (doneAfter(entryToLog) && roundOpen === null) {
        const index = orderedEntries.findIndex((entry) => entry.key === entryToLog.key);
        const nextEntry = orderedEntries.slice(index + 1).find((entry) => !doneAfter(entry));
        if (nextEntry) {
          setFocusKey(nextEntry.key);
          setOpenKey(nextEntry.key);
        }
      }

      // The clock MEASURES from the end of the last complete round, so it is
      // restarted only when this log closes one (rest_seconds_actual is data,
      // and append-only means it can never be added later); auto-start
      // governs only whether the strip appears. Mid-round the clock keeps
      // running from the previous round's end, which is what the NEXT round's
      // first member will record.
      const now = Date.now();
      if (!placement.roundOpenAfter) restRef.current = { startedAt: now };
      const position = setPositionLabel(set, setsForEntryOf(entryToLog, next, rx, knownRxIds));
      const forLabel = `${entryToLog.name} ${position.text}`;
      const targetRestSeconds = getExerciseRestSeconds(
        entryToLog.exercise_id,
        bracket?.rest_seconds ?? null,
      );
      // No rest after the pair's own last set either: what follows is the
      // next exercise, and the same as the old "Log round" the clock keeps
      // measuring for it.
      const pairFinished =
        partner !== null && doneAfter(entryToLog) && doneAfter(partner);
      const showStrip = autoStartRest && !placement.roundOpenAfter && !pairFinished;
      if (showStrip)
        setRest({ startedAt: now, targetSeconds: targetRestSeconds, forLabel });
      else setRest(null);
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
        setSetType(
          warmupsLogged < warmupSets(entryToLog) ? "warmup" : "working",
        );
      // The rating does NOT carry to the next set. Load and reps do, because
      // they are the plan repeating; how hard set 3 felt is not a prediction
      // about set 4, and a sticky value would quietly attach one lifter's one
      // honest answer to every row after it.
      setRpe(null);
      setExtraSetArmed(false);
      return true;
    } catch (error) {
      reportError(error, "queue set");
      setLogError(
        error instanceof LoadIntegrityError
          ? error.message
          : "This set could not be saved locally. Check storage and retry.",
      );
      return false;
    } finally {
      setLogSaving(false);
      window.setTimeout(() => setLogLocked(false), LOG_LOCK_MS);
    }
  };

  /** One member of a superset round: the same durable path as any set
   *  (logSet), then that member's round draft is cleared so the next round
   *  stages fresh from the plan. Rest and the recorded rest follow the
   *  round, not the member (see `placement` in logSet). */
  const logRoundMember = (member: ExerciseEntry, draft: SetDraft) => {
    if (!sessionId || !setsLoaded || !prefsReady || setsFailed) return;
    void logSet(draft, member).then((saved) => {
      if (!saved) return;
      setRoundDrafts((prior) => {
        const next = { ...prior };
        delete next[member.key];
        return next;
      });
    });
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
    if (kind === "swap") {
      setPicking("swap");
      setSwapKey(memberKey);
    }
  };

  const openPad = (
    kind: PadKind,
    fromPlates = false,
    memberKey: string | null = null,
    forCorrection = false,
  ) => {
    setRoundInputKey(memberKey);
    setPad({ kind, fromPlates, forCorrection });
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
      jumpToEntry(existing);
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
    // the dock and Log follow the new exercise, in Focus as well as List
    setFocusKey(`extra:${ex.id}`);
    setOpenKey(`extra:${ex.id}`);
    setSelectedEntryKey(`extra:${ex.id}`);
  };

  // ---- corrections ---------------------------------------------------------

  const round2 = (n: number) => Math.round(n * 100) / 100;

  /** The entry that holds a set. */
  const entryOfSet = (s: SetInsert): ExerciseEntry | null =>
    entries.find((e) => setsForEntry(e).some((x) => x.id === s.id)) ?? null;

  /**
   * What a set was lifted on — its own exercise's name, equipment and
   * convention (per hand or total) — never the open entry's. Fix can be
   * tapped for a set of an exercise that is not the one on screen (the LAST
   * SET card after the final set of an exercise, a superset's other member),
   * and deriving the convention from whatever happened to be open stored a
   * bench set as "12.5 × 2" (C1).
   */
  const conventionForSet = (s: SetInsert) => {
    const entry = entryOfSet(s);
    const equipmentOfSet = equipMap[s.exercise_id] ?? null;
    const swappedAway =
      entry?.substitutedFor !== undefined &&
      s.exercise_id === entry.substitutedFor.exercise_id;
    const name =
      (swappedAway ? entry?.substitutedFor?.name : undefined) ??
      (entry && entry.exercise_id === s.exercise_id ? entry.name : undefined) ??
      allExercises.find((x) => x.id === s.exercise_id)?.name ??
      entry?.name ??
      "this set";
    const bracket = entry?.brackets.find((b) => b.id === s.prescription_id);
    const mode = resolveLoadEntry({
      override: getExercisePref(s.exercise_id).loadEntry,
      // the coach's convention describes the movement the coach named
      prescribed:
        bracket && bracket.exercise_id === s.exercise_id
          ? (bracket.load_entry ?? null)
          : null,
      equipment: equipmentOfSet,
      name,
    });
    return {
      entry,
      name,
      equipment: equipmentOfSet,
      loadEntry: mode,
    };
  };

  /** Tap a logged set: its numbers open in the Fix sheet. The old row is
   *  untouched until Save, and a row that is already gone (voided, replaced)
   *  cannot be fixed. */
  const startCorrection = (s: SetInsert) => {
    if (editing?.set.id === s.id) return;
    // Always the live row: a copy of a set that has since been corrected would
    // re-void the original and insert a second replacement.
    const live = setsRef.current.find((x) => x.id === s.id);
    if (!live) return;
    setVoidArm(null);
    setMoreOpen(false);
    setRpeSheetOpen(false);
    setNoteFor(null);
    const conv = conventionForSet(live);
    const typedKg = round2(enteredKg(live.load_kg, conv.loadEntry));
    const oldAuthored =
      live.load_entry === conv.loadEntry &&
      live.entered_load != null &&
      live.entered_unit != null;
    setEditing({
      set: live,
      name: conv.name,
      equipment: conv.equipment,
      loadEntry: conv.loadEntry,
      tracking: isTimed(conv.entry) ? "time" : "reps",
      entryKg: typedKg,
      reps: live.reps,
      setType: live.set_type,
      // A correction is the only way to rate a set after the fact, so the
      // row's rating comes into the sheet exactly as its load and reps do.
      rpe: live.rpe ?? null,
      // load_kg is the TOTAL; it is shown in the convention the exercise is
      // in NOW, so Save — which totals the entry by that same convention —
      // round-trips exactly even if the toggle was flipped since the set.
      enteredLoad: oldAuthored
        ? live.entered_load!
        : unit === "kg"
          ? typedKg
          : round2(kgToLb(typedKg)),
      enteredUnit: oldAuthored ? live.entered_unit! : unit,
      loadEdited: false,
      saving: false,
    });
  };

  const cancelCorrection = () => setEditing(null);

  /** Void the old row and append its replacement at the same set_index, in one
   *  durable local transaction (replacement first, so a void can never land
   *  without it). Nothing about WHEN the set happened changes: performed_at,
   *  the rest before it and the rest clock after it all stand. Visible state
   *  changes only after the commit; a failure leaves the original on screen. */
  const commitCorrection = async (
    old: SetInsert,
    correction: {
      load_kg: number;
      reps: number;
      set_type: SetType;
      load_entry: LoadEntry | null;
      entered_load?: number | null;
      entered_unit?: Unit | null;
      rpe: number | null;
    },
    failureContext: string,
    successToast?: string,
  ): Promise<boolean> => {
    if (!sessionId) return false;
    if (isNoopCorrection(old, correction)) return true;
    if (pendingSetMutationIdsRef.current.has(old.id)) return false;
    const next = correctedSet(old, correction);
    const note = setNotes[old.id] || undefined;
    pendingSetMutationIdsRef.current.add(old.id);
    setPendingEntryWrites((count) => count + 1);
    try {
      await outbox.enqueueCorrection(sessionId, next, old.id, note);
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
      if (note) {
        const nextNotes = { ...setNotes, [next.id]: note };
        delete nextNotes[old.id];
        setSetNotes(nextNotes);
      }
      if (successToast) toast(successToast);
      return true;
    } catch (e) {
      reportError(e, failureContext);
      return false;
    } finally {
      pendingSetMutationIdsRef.current.delete(old.id);
      setPendingEntryWrites((count) => Math.max(0, count - 1));
    }
  };

  const saveCorrection = async () => {
    // Corrections are never gated by the log lock (Decision 6): the lock
    // exists only to stop a double LOG tap inserting the same set twice, and
    // a correction is a deliberate edit to a set that already exists.
    if (!editing || !sessionId || editing.saving) return;
    const draft = editing;
    const old = draft.set;
    // The edited number is what was typed; setLoad derives everything else.
    // An unedited load keeps the old row's fields verbatim.
    let built;
    try {
      built = draft.loadEdited
        ? buildSetLoad({
            typedValue: draft.enteredLoad,
            typedUnit: draft.enteredUnit,
            loadEntry: draft.loadEntry,
            maxTotalKg: MAX_LOAD_KG,
          })
        : {
            load_kg: old.load_kg,
            load_entry: old.load_entry ?? null,
            entered_load: old.entered_load ?? null,
            entered_unit: old.entered_unit ?? null,
          };
    } catch (e) {
      reportError(e, "correct set load");
      toast(e instanceof LoadIntegrityError ? e.message : "That weight could not be saved");
      return;
    }
    const correction = {
      ...built,
      reps: draft.reps,
      set_type: draft.setType,
      rpe: draft.rpe,
    };
    if (isNoopCorrection(old, correction)) {
      setEditing(null);
      return;
    }
    setEditing({ ...draft, saving: true });
    const holder = entryOfSet(old);
    const position = setPositionLabel(old, holder ? setsForEntry(holder) : [old]);
    const ok = await commitCorrection(
      old,
      correction,
      "correct set",
      `${position.kind === "warmup" ? "Warmup" : "Set"} ${position.number} corrected`,
    );
    // closed only once the replacement is durable; a failure keeps the sheet
    // (and every value typed in it) open for another try
    setEditing(ok ? null : { ...draft, saving: false });
  };

  /** Rate a set without opening the Fix sheet: still a correction underneath
   *  (void + new row at the same set_index, `sets` is append-only), only the
   *  rating changes. */
  const rateSet = async (old: SetInsert, nextRpe: number | null) => {
    await commitCorrection(
      old,
      {
        load_kg: old.load_kg,
        reps: old.reps,
        set_type: old.set_type,
        load_entry: old.load_entry ?? null,
        rpe: nextRpe,
      },
      "rate set",
    );
  };

  /** Void a logged set: hide it from every view via an append-only
   *  set_voids insert. The row itself is never edited or deleted. */
  const voidSet = async (s: SetInsert) => {
    if (!sessionId) return;
    if (pendingSetMutationIdsRef.current.has(s.id)) return;
    pendingSetMutationIdsRef.current.add(s.id);
    setPendingEntryWrites((count) => count + 1);
    try {
      await outbox.enqueue({ kind: "insert", table: "set_voids", payload: { set_id: s.id } });
    } catch (e) {
      reportError(e, "remove set");
      pendingSetMutationIdsRef.current.delete(s.id);
      setPendingEntryWrites((count) => Math.max(0, count - 1));
      return;
    }
    pendingSetMutationIdsRef.current.delete(s.id);
    setPendingEntryWrites((count) => Math.max(0, count - 1));
    setVoidArm(null);
    if (editing?.set.id === s.id) setEditing(null);
    if (noteFor === s.id) setNoteFor(null);
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
    toast(`Set ${s.set_index + 1} removed`);
  };

  const persistSkips = (next: Record<string, SkipRecord>) => {
    setSkips(next);
    if (sessionId)
      cacheSet(cacheKeys.sessionSkips(sessionId), next).catch(
        (e: unknown) => reportError(e, "cache skips"),
      );
  };

  /** The planned id a skip is recorded against — the same one the swap
   *  bookkeeping already uses (`plannedExerciseId`), so a skip written
   *  before or after a swap both name the exercise the PLAN asked for. */
  const skipRecordFor = (
    entry: ExerciseEntry,
    scope: SkipRecord["scope"],
    reason: string | null,
  ): SkipRecord => ({
    entryKey: entry.key,
    prescriptionId: isLocalBracket(entry.brackets[0]?.id)
      ? null
      : (entry.brackets[0]?.id ?? null),
    exerciseId: plannedExerciseId(entry),
    scope,
    reason,
  });

  /** Plain SKIP/UNSKIP — the overview row action, and un-skip from anywhere.
   *  No reason attached; the hero's own Skip collects one first, below. */
  const toggleSkip = (entry: ExerciseEntry) => {
    const next = { ...skips };
    if (next[entry.key]) delete next[entry.key];
    else next[entry.key] = skipRecordFor(entry, "exercise", null);
    persistSkips(next);
  };

  /** The hero's Skip action, after an optional reason chip or free text. */
  const skipEntryWithReason = (entry: ExerciseEntry, reason: string | null) => {
    persistSkips({
      ...skips,
      [entry.key]: skipRecordFor(entry, "exercise", reason),
    });
    startRestAfterSkippedPartner(entry);
  };
  /** A1 was logged mid-round and then A2 was skipped: the round closes here,
   *  so the clock and strip start from A1's set rather than staying on the
   *  PREVIOUS round's end (which would inflate the next set's recorded rest). */
  const startRestAfterSkippedPartner = (skippedEntry: ExerciseEntry) => {
    const pair = twoMemberSuperset(orderedEntries, skippedEntry.key);
    if (!pair) return;
    const partner = pair[0].key === skippedEntry.key ? pair[1] : pair[0];
    if (partner.key in skips || entryProgress(partner) <= entryProgress(skippedEntry)) return;
    const last = newestOf(setsForEntry(partner));
    const startedAt = last ? Date.parse(last.performed_at) : NaN;
    if (!last || Number.isNaN(startedAt)) return;
    restRef.current = { startedAt };
    const bracket = bracketFor(partner, Math.max(0, entryProgress(partner) - 1), "working");
    const targetSeconds = getExerciseRestSeconds(partner.exercise_id, bracket?.rest_seconds ?? null);
    const forLabel = `${partner.name} ${setPositionLabel(last, setsForEntry(partner)).text}`;
    if (autoStartRest) {
      setRest({ startedAt, targetSeconds, forLabel });
      armRestAlert(startedAt + targetSeconds * 1000, forLabel);
    }
    mirrorRest(autoStartRest ? targetSeconds : null, autoStartRest ? forLabel : null);
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
    if (skips[entry.key]) {
      const nextSkips = { ...skips };
      delete nextSkips[entry.key];
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
  const swapTarget = swapKey === null ? null : (entries.find((e) => e.key === swapKey) ?? null);
  const pickedExercise = (ex: ExerciseRow) => {
    if (picking === "swap" && (swapTarget ?? openEntry)) swapExercise((swapTarget ?? openEntry)!, ex);
    else addExercise(ex);
  };

  // ---- per-set notes -------------------------------------------------------

  /** Save a note on a LIVE set. The note appears only once its outbox write is
   *  durable; a failure keeps the sheet (and what was typed) open. */
  const saveNote = async (setId: string, note: string): Promise<boolean> => {
    if (!sessionId) return false;
    // never a voided or replaced row: those are not in `sets`
    if (!setsRef.current.some((x) => x.id === setId)) return false;
    try {
      await outbox.enqueue({
        kind: "insert",
        table: "set_notes",
        payload: { set_id: setId, note },
      });
    } catch (e) {
      reportError(e, "save set note");
      return false;
    }
    const next = { ...setNotes, [setId]: note };
    setSetNotes(next);
    cacheSet(cacheKeys.sessionSetNotes(sessionId), next).catch((e: unknown) =>
      reportError(e, "cache set notes"),
    );
    return true;
  };

  // ---- pad request ---------------------------------------------------------

  const padRequest = (): PadRequest | null => {
    if (!pad) return null;
    // The Fix sheet's own numbers: its draft, its convention, its caps.
    if (pad.forCorrection && editing && (pad.kind === "load" || pad.kind === "reps")) {
      const draft = editing;
      if (pad.kind === "reps") {
        return {
          label: `${draft.name.toUpperCase()} · REPS`,
          action: "SET REPS",
          initial: String(draft.reps),
          allowDecimal: false,
          onCommit: (value) => {
            setEditing((prior) =>
              prior
                ? { ...prior, reps: Math.min(MAX_REPS, Math.max(0, Math.round(value))) }
                : prior,
            );
            setPad(null);
          },
          onCancel: () => setPad(null),
        };
      }
      const perSideDraft = draft.loadEntry === "per_side";
      const maxKg = perSideDraft ? MAX_LOAD_KG / 2 : MAX_LOAD_KG;
      return {
        label: `${draft.name.toUpperCase()} · ${
          perSideDraft ? "WEIGHT ON EACH DUMBBELL" : "ONE TOTAL WEIGHT"
        } IN ${unit.toUpperCase()}`,
        action: "SET LOAD",
        initial: String(
          stagedDisplayLoad(draft.entryKg, draft.enteredLoad, draft.enteredUnit, unit),
        ),
        allowDecimal: true,
        onCommit: (value) => {
          const kg = Math.min(maxKg, Math.max(0, fromDisplay(value, unit)));
          setEditing((prior) =>
            prior
              ? {
                  ...prior,
                  entryKg: round2(kg),
                  enteredLoad: value,
                  enteredUnit: unit,
                  loadEdited: true,
                }
              : prior,
          );
          setPad(null);
        },
        onCancel: () => setPad(null),
      };
    }
    const roundEntry =
      roundInputKey === null
        ? null
        : (entries.find((entry) => entry.key === roundInputKey) ?? null);
    // Base/bar weight is a per-exercise pref (synced to the account), not part of
    // any draft — it does not go through the round-vs-open-entry draft
    // split below, which exists only for entryKg/reps.
    if (pad.kind === "base") {
      const baseTarget = roundEntry ?? openEntry;
      if (!baseTarget) return null;
      const baseEquipment = equipMap[baseTarget.exercise_id] ?? null;
      const isMachineBase = baseEquipment !== "barbell";
      const currentBaseKg = getExerciseBarKg(
        baseTarget.exercise_id,
        unit,
        baseEquipment,
      );
      return {
        label: `${baseTarget.name.toUpperCase()} · ${
          isMachineBase ? "BASE WEIGHT" : "BAR WEIGHT"
        } IN ${unit.toUpperCase()}`,
        action: "BACK TO PLATES",
        initial: String(toDisplay(currentBaseKg, unit)),
        allowDecimal: true,
        onCommit: (value) => {
          const kg = Math.min(
            MAX_BAR_KG,
            Math.max(0, fromDisplay(value, unit)),
          );
          setExerciseBarKg(baseTarget.exercise_id, Math.round(kg * 100) / 100);
          setPad(null);
          setSheet("plates");
        },
        onCancel: () => {
          setPad(null);
          setSheet("plates");
        },
      };
    }
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
      if (pad.kind === "duration") {
        return {
          label: `${roundEntry.name.toUpperCase()} · DURATION IN SECONDS`,
          action: "SET DURATION",
          initial: String(draft.durationSeconds ?? 60),
          allowDecimal: false,
          onCommit: (value) => {
            updateDraft({ durationSeconds: Math.min(3600, Math.max(0, Math.round(value))) });
            setPad(null);
          },
          onCancel: () => setPad(null),
        };
      }
      if (pad.kind === "load") {
        const roundUnit = unit;
        const perSideRound = entryMode === "per_side";
        const max = perSideRound ? MAX_LOAD_KG / 2 : MAX_LOAD_KG;
        return {
          label: `${roundEntry.name.toUpperCase()} · ${
            perSideRound ? "WEIGHT ON EACH DUMBBELL" : "ONE TOTAL WEIGHT"
          } IN ${roundUnit.toUpperCase()}`,
          action: pad.fromPlates ? "BACK TO PLATES" : "SET LOAD",
          initial: String(stagedDisplayLoad(
            draft.entryKg, draft.enteredLoad, draft.enteredUnit, roundUnit,
          )),
          allowDecimal: true,
          onCommit: (value) => {
            const kg = Math.min(max, Math.max(0, fromDisplay(value, roundUnit)));
            updateDraft({ entryKg: Math.round(kg * 100) / 100, enteredLoad: value, enteredUnit: roundUnit });
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
    if (pad.kind === "load" && openEntry) {
      const maxEntryKg = openView?.maxEntryKg ?? MAX_LOAD_KG;
      return {
        label: `${openEntry.name.toUpperCase()} · ${
          perSide ? "WEIGHT ON EACH DUMBBELL" : "ONE TOTAL WEIGHT"
        } IN ${inputUnit.toUpperCase()}`,
        action: pad.fromPlates ? "BACK TO PLATES" : "SET LOAD",
        initial: String(displayedLoad),
        allowDecimal: true,
        onCommit: (v) => {
          const kg = Math.min(maxEntryKg, Math.max(0, fromDisplay(v, inputUnit)));
          const entryKg = Math.round(kg * 100) / 100;
          rememberStagedDraft(openEntry, { entryKg, enteredLoad: v, enteredUnit: inputUnit });
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
    if (pad.kind === "reps" && openEntry) {
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
    if (pad.kind === "duration" && openEntry) {
      return {
        label: `${openEntry.name.toUpperCase()} · DURATION IN SECONDS`,
        action: "SET DURATION",
        initial: String(durationSeconds),
        allowDecimal: false,
        onCommit: (value) => {
          const next = Math.min(3600, Math.max(0, Math.round(value)));
          rememberStagedDraft(openEntry, { durationSeconds: next });
          setDurationSeconds(next);
          setPad(null);
        },
        onCancel: () => setPad(null),
      };
    }
    if (pad.kind !== "rest") return null;
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

  // ---- round drafts, units, and what comes next ----------------------------
  //
  // Everything below is derived from state declared above and used by the
  // render and by hooks that must run on every render, so it lives ahead of
  // the loading early-returns.

  /** A superset member that is not the open entry has no staged draft: stage
   *  one from the plan, exactly as opening it would. */
  const defaultRoundDraft = (entry: ExerciseEntry): SetDraft => {
    const kind = suggestedKind(entry);
    const bracket = bracketFor(entry, countFor(entry, kind), kind);
    const entryMode = resolveLoadEntry({
      override: prefFor(entry.exercise_id).loadEntry,
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
      lastThisSession: last
        ? {
            load_kg: last.load_kg,
            reps: last.reps,
            load_entry: last.load_entry,
            entered_load: last.entered_load,
            entered_unit: last.entered_unit,
          }
        : null,
      lastSession: lastActuals[entry.exercise_id] ?? null,
    }, bodyweightFallback(equipMap[entry.exercise_id] ?? null));
    const authoredLoad = bracket?.entered_load ?? null;
    const authoredUnit = bracket?.entered_unit ?? null;
    const sourceEntryKg = authoredLoad !== null && authoredUnit !== null
        ? Math.round(fromDisplay(authoredLoad, authoredUnit) * 100) / 100
        : Math.round(enteredKg(prefill.loadKg, entryMode) * 100) / 100;
    const authoredInDisplayUnit = authoredLoad !== null && authoredUnit === unit;
    const repeatTyped =
      prefill.entered && prefill.entered.unit === unit && prefill.entered.entry === entryMode
        ? prefill.entered.load
        : undefined;
    return {
      entryKg: authoredInDisplayUnit
        ? sourceEntryKg
        : repeatTyped !== undefined
          ? Math.round(fromDisplay(repeatTyped, unit) * 100) / 100
          : Math.round(fromDisplay(toDisplay(sourceEntryKg, unit), unit) * 100) / 100,
      reps: prefill.reps,
      setType: kind,
      rpe: null,
      ...(authoredInDisplayUnit
        ? { enteredLoad: authoredLoad, enteredUnit: unit }
        : repeatTyped !== undefined
          ? { enteredLoad: repeatTyped, enteredUnit: unit }
          : {}),
    };
  };

  const roundDraftFor = (entry: ExerciseEntry): SetDraft => {
    const staged = stagedDraftsRef.current[`${entry.key}:${entry.exercise_id}`];
    return roundDrafts[entry.key] ??
      (entry.key === openEntry?.key
        ? staged ?? { entryKg, reps, setType: setType as BracketKind, rpe }
        : defaultRoundDraft(entry));
  };

  /** Is this entry one half of the superset round on screen? */
  const inLiveRound = (entry: ExerciseEntry): boolean =>
    focusSupersetPair !== null &&
    roundView !== null &&
    (entry.key === focusSupersetPair[0].key || entry.key === focusSupersetPair[1].key);
  /** The member key to hand a sheet or the pad so its edits land in that
   *  member's round draft; null for an ordinary entry, whose staged values
   *  live at the top level. */
  const memberKeyFor = (entry: ExerciseEntry): string | null =>
    inLiveRound(entry) ? entry.key : null;

  /** The draft the dock shows for an entry. */
  const draftOf = (entry: ExerciseEntry): SetDraft =>
    inLiveRound(entry)
      ? roundDraftFor(entry)
      : entry.key === openEntry?.key
        ? openDraft
        : defaultRoundDraft(entry);

  /** Switching the unit changes what is DISPLAYED for this session only; it
   *  never rewrites how a staged number was entered, and never touches the
   *  device default (Settings) or a logged row. */
  const switchWorkoutUnit = (next: Unit) => {
    if (next === unit || !prefsReady) return;
    const ownerId = knownOwner();
    const requestedSession = sessionId;
    const identityEpoch = identityEpochRef.current;
    // Stamp a prefilled draft's displayed value before changing units. An
    // authored value already has its own unit and must keep that provenance.
    if (openEntry && currentDraft?.enteredUnit === undefined) {
      rememberStagedDraft(
        openEntry,
        { enteredLoad: displayedLoad, enteredUnit: unit },
        false,
      );
    }
    if (focusSupersetPair) {
      setRoundDrafts((prior) => {
        const nextDrafts = { ...prior };
        for (const member of focusSupersetPair) {
          const draft = prior[member.key] ?? roundDraftFor(member);
          nextDrafts[member.key] = draft.enteredUnit !== undefined
            ? draft
            : {
                ...draft,
                enteredLoad: toDisplay(draft.entryKg, unit),
                enteredUnit: unit,
              };
        }
        return nextDrafts;
      });
    }
    setSessionUnitState(ownerId && requestedSession
      ? { ownerId, sessionId: requestedSession, unit: next }
      : null);
    if (ownerId && requestedSession) {
      const isCurrent = () =>
        identityEpochRef.current === identityEpoch &&
        knownOwner() === ownerId &&
        sessionIdRef.current === requestedSession;
      void writeSessionPrefs(
        ownerId,
        requestedSession,
        { unit: next },
        isCurrent,
      ).catch((error: unknown) => {
        reportError(error, "save session unit");
        if (isCurrent()) toast("Unit choice may reset after reload");
      });
    }
  };

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

  /** Where the NEXT set of an entry falls, the way the lifter counts it:
   *  "set 3 of 4", or "warmup 2 of 2" while a warmup is staged. Null for a set
   *  by feel, which has no count to quote. */
  const nextPositionText = (entry: ExerciseEntry, draft: SetDraft): string | null => {
    if (draft.setType === "warmup") {
      const planned = warmupSets(entry);
      const number = warmupCount(entry) + 1;
      return `warmup ${number} of ${Math.max(planned, number)}`;
    }
    const total = targetSets(entry);
    return total === 0 ? null : `set ${Math.min(entryProgress(entry) + 1, total)} of ${total}`;
  };

  /** "Next: Row · set 3 of 4" — one line, from the same logic the focus
   *  deck's own labels use, so the two never name a different next set. In a
   *  live round the next thing is the round (or the member that goes on);
   *  otherwise it is the open entry's next set, or the next exercise once it
   *  is done. Null once there is nothing left. */
  const nextSetLabel = (): string | null => {
    if (focusSupersetPair && roundView) {
      if (!roundView.tail) {
        const letter = supersetLetter(focusSupersetPair[0].brackets[0]?.superset_group ?? 1);
        return roundView.roundTotal > 0
          ? `Next: Superset ${letter}, round ${roundView.roundIndex} of ${roundView.roundTotal}`
          : `Next: Superset ${letter}, round ${roundView.roundIndex}`;
      }
      const going = focusSupersetPair[roundView.nowIndex];
      const total = targetSets(going);
      return total === 0
        ? `Next: ${going.name} · by feel`
        : `Next: ${going.name} · set ${Math.min(entryProgress(going) + 1, total)} of ${total}`;
    }
    const target = openEntry && !entryDone(openEntry) ? openEntry : advanceTo;
    if (!target) return null;
    const position = nextPositionText(target, draftOf(target)) ?? "by feel";
    return `Next: ${target.name} · ${position}`;
  };

  // The rest-over tone and notification, once per rest, whatever is on screen
  // when the target is reached (H2). Mounted here, at the top of the screen,
  // rather than inside a rest component that comes and goes with sheets and
  // with the Focus/List switch.
  useRestCue(rest, nextSetLabel());

  // ---- render --------------------------------------------------------------

  if (active === undefined) return <div className="screen muted">Loading…</div>;
  if (!active) return null;

  // ---- receipts: one set's own state, never the aggregate chip -------------

  const receiptKindOf = (setId: string): { receipt: SetReceipt; kind: ReceiptKind } => {
    const receipt = receiptForSet(setId);
    const held =
      receipt.state === "local" &&
      setQueueHeld(
        receiptSnapshot.entries,
        setId,
        receiptSnapshot.correctionLinks[setId],
      );
    // "Sending" claims only what the queue can prove: it is flushing right now
    // and this set's writes are waiting in it (not held, not already
    // acknowledged). The outbox has no per-operation in-flight evidence.
    const sending =
      receipt.state === "local" && !held && outboxStatus.state === "syncing";
    return { receipt, kind: receiptKind(receipt, { sending, held }) };
  };
  /** "Correction waiting to send": while a correction's void is held behind its
   *  replacement the server holds BOTH rows live, so the pair is named on the
   *  replacement (the original is hidden here, voided locally). */
  const pairNoteFor = (setId: string): string | undefined => {
    const waiting = correctionWaiting(
      receiptForSet(setId),
      receiptSnapshot.correctionLinks,
      setId,
    );
    if (!waiting) return undefined;
    const original = receiptSnapshot.entries
      .map((entry) => entry.op)
      .find(
        (op) =>
          op.kind === "insert" &&
          op.table === "sets" &&
          op.payload.id === waiting.originalId,
      );
    const was =
      original && original.kind === "insert" && original.table === "sets"
        ? ` It replaces ${lineForSet(original.payload)}.`
        : "";
    return `Correction waiting to send.${was} The original stays live on the server until it lands.`;
  };
  const receiptFor = (setId: string, announce = true, mark = false) => {
    const { receipt, kind } = receiptKindOf(setId);
    return (
      <SetReceiptStatus
        receipt={receipt}
        sending={kind === "sending"}
        held={kind === "held"}
        announce={announce}
        mark={mark}
        onReview={() => openReceiptReview(receipt)}
      />
    );
  };

  // ---- reading a logged set back -------------------------------------------

  const lineForSet = (s: SetInsert): string => {
    const holder = entryOfSet(s);
    return formatSetLine(s, {
      unit,
      tracking: holder ? (isTick(holder) ? "done" : isTimed(holder) ? "time" : "reps") : "reps",
      bodyweight: isBodyweightEquipment(equipMap[s.exercise_id] ?? null),
    });
  };
  const positionOfSet = (s: SetInsert) => {
    const holder = entryOfSet(s);
    return setPositionLabel(s, holder ? setsForEntry(holder) : [s]);
  };

  /** rest AFTER a given set: next exercise-set's stored value, or live timer.
   *
   *  Scoped to the set's OWN exercise, not the entry's: set_index counts per
   *  exercise, so a swapped entry holds two runs that both start at 0 and
   *  "the set after this one" must never be read across them. The live clock
   *  belongs to the newest set of all. */
  const restAfter = (s: SetInsert): string | null => {
    const run = setsForExercise(s.exercise_id);
    const nextSet = run.find((x) => x.set_index === s.set_index + 1);
    if (nextSet)
      return nextSet.rest_seconds_actual !== null
        ? `rest ${formatClock(nextSet.rest_seconds_actual)}`
        : null;
    const isLast = s.id === lastSet?.id && run.every((x) => x.set_index <= s.set_index);
    if (isLast && restRef.current) {
      const el = restElapsedSeconds();
      if (el !== null && el <= MAX_REST_SECONDS) return `rest ${formatClock(el)}`;
    }
    return null;
  };

  /** The logged sets of an entry as ledger rows: where each sits, what it was,
   *  its own receipt, tap to fix, ✕ to void. */
  const renderLoggedRows = (entry: ExerciseEntry) => {
    const own = setsForEntry(entry);
    const logged = own
      .slice()
      .sort(
        (a, b) =>
          b.set_index - a.set_index ||
          b.performed_at.localeCompare(a.performed_at),
      );
    if (logged.length === 0) return null;
    return (
      <div className="ledger-sets" role="group" aria-label={`logged sets for ${entry.name}`}>
        {logged.map((set) => {
          const position = setPositionLabel(set, own);
          const meta = [
            set.rpe != null ? `RPE ${set.rpe}` : null,
            restAfter(set),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <LoggedSetRow
              key={set.id}
              label={position.kind === "warmup" ? `W${position.number}` : String(position.number)}
              position={position.text}
              text={lineForSet(set)}
              meta={meta || undefined}
              note={setNotes[set.id] || undefined}
              receipt={receiptFor(set.id, false, true)}
              pairNote={pairNoteFor(set.id)}
              // a tick has no numbers to correct
              onFix={isTick(entry) ? undefined : () => startCorrection(set)}
              onVoid={() => void voidSet(set)}
              voidArmed={voidArm === set.id}
              onArmVoid={() => setVoidArm(set.id)}
              editing={editing?.set.id === set.id}
            />
          );
        })}
      </div>
    );
  };

  // ---- the dock ------------------------------------------------------------

  /** the staged set the dock is editing, and how its exercise is loaded */
  const nowDraft = nowEntry ? draftOf(nowEntry) : null;
  const nowView = nowEntry && nowDraft ? viewFor(nowEntry, nowDraft) : null;

  /** How a change to an entry's staged set is applied: a round member keeps
   *  its own draft; anything else edits the top-level staged values. */
  const draftChangeFor = (entry: ExerciseEntry) => (next: Partial<SetDraft>) => {
    setLogError(null);
    if (inLiveRound(entry)) {
      setRoundDrafts((prior) => ({
        ...prior,
        [entry.key]: { ...roundDraftFor(entry), ...next },
      }));
      return;
    }
    rememberStagedDraft(entry, next);
    if (next.entryKg !== undefined) setEntryKg(next.entryKg);
    if (next.reps !== undefined) setReps(next.reps);
    if (next.setType !== undefined) setSetType(next.setType);
    if (next.rpe !== undefined) setRpe(next.rpe);
    if (next.durationSeconds !== undefined) setDurationSeconds(next.durationSeconds);
  };

  /** "LOG SET", "LOG WARMUP", "LOG EXTRA SET", "DONE", or "Log A1" in a round. */
  const logLabelFor = (entry: ExerciseEntry, draft: SetDraft, tag?: string): string => {
    if (!setsLoaded || !prefsReady) return "LOADING…";
    if (setsFailed) return "LOG UNAVAILABLE";
    if (tag) return `Log ${tag}`;
    if (isTick(entry)) return "DONE";
    if (draft.setType === "warmup") return "LOG WARMUP";
    return entryDone(entry) ? "LOG EXTRA SET" : "LOG SET";
  };

  /** Where the pad and the plate sheet read their numbers from: a round
   *  member's draft or the open entry's, never a stale other one. */
  const roundInputEntry =
    roundInputKey === null
      ? null
      : (entries.find((entry) => entry.key === roundInputKey) ?? null);
  const plateEntry = roundInputEntry ?? openEntry;

  const req = padRequest();

  /** The picture of an exercise's load, with the handlers of THIS screen. */
  const pictureFor = (
    entry: ExerciseEntry,
    draft: SetDraft,
    tag = "",
  ): LoadPictureModel | null => {
    if (isTick(entry)) return null;
    const view = viewFor(entry, draft);
    const tagPrefix = tag ? `${tag} · ` : "";
    const memberKey = memberKeyFor(entry);
    if (view.style === "plates" && view.plateSplit) {
      return {
        kind: "plates",
        split: view.plateSplit,
        baseKg: view.baseKg,
        baseName: view.baseName,
        baseKnown: view.baseKnown,
        tag: tagPrefix,
        onOpen: () => openSheet("plates", memberKey),
      };
    }
    if (view.style === "stack") {
      return {
        kind: "stack",
        totalKg: view.totalLoadKg,
        canSwitch: view.canSwitchStyle,
        tag: tagPrefix,
        onOpen: view.canSwitchStyle ? () => openSheet("plates", memberKey) : undefined,
      };
    }
    if (view.bellWord !== null) {
      return {
        kind: "dumbbell",
        implementKg: draft.entryKg,
        displayLoad: stagedDisplayLoad(
          draft.entryKg,
          draft.enteredLoad,
          draft.enteredUnit,
          unit,
        ),
        pair: view.perSide,
        word: view.bellWord,
        onToggle: view.canToggleEntry
          ? () => toggleLoadEntryFor(entry, view.mode)
          : undefined,
      };
    }
    if (view.bodyweight) {
      return {
        kind: "bodyweight",
        addedOn: draft.entryKg > 0 || bwAddOpen === entry.key,
        timed: isTimed(entry),
      };
    }
    return null;
  };

  /** The dock for the entry being edited: the numbers, the keys, LOG. In a
   *  live superset round that is the NOW member, and LOG says which. */
  const renderDock = (keys: ReactNode) => {
    const entry = nowEntry;
    if (!entry) return null;
    const draft = draftOf(entry);
    const view = viewFor(entry, draft);
    const inRound = inLiveRound(entry);
    const tag = inRound
      ? (supersetInfo.get(entry.key)?.tag ?? undefined)
      : undefined;
    const onDraftChange = draftChangeFor(entry);
    return (
      <>
      {logError && (
        <p className="form-error session-error" role="alert">
          {logError}
        </p>
      )}
      {setsFailed && (
        <p className="microcopy session-error">
          This session’s logged sets could not be read from this device, so a
          new set would be numbered as if nothing had been logged. Reload to
          try again. Nothing already logged is lost.
        </p>
      )}
      <SetEditor
        entry={entry}
        draft={draft}
        tracking={trackingOf(entry)}
        loadPresentation={{ perSide: view.perSide, noLoad: view.noLoad }}
        unit={unit}
        maxEntryKg={view.maxEntryKg}
        loadSteps={loadSteps(entry.exercise_id, unit)}
        logLabel={logLabelFor(entry, draft, tag)}
        logClassName={`btn ${entryDone(entry) && !inRound ? "btn-outline-ink" : "btn-primary"} btn-log${logHeld ? " is-held" : ""}`}
        saving={logSaving}
        disabled={!setsLoaded || !prefsReady || setsFailed}
        keysSlot={keys}
        memberTag={tag}
        addedLoad={
          view.bodyweight && trackingOf(entry) === "reps"
            ? {
                on: draft.entryKg > 0 || bwAddOpen === entry.key,
                onAdd: () => setBwAddOpen(entry.key),
                onRemove: () => {
                  setBwAddOpen(null);
                  onDraftChange({
                    entryKg: 0,
                    enteredLoad: undefined,
                    enteredUnit: undefined,
                  });
                },
              }
            : null
        }
        onDraftChange={onDraftChange}
        onLog={() =>
          tapLog(() => {
            if (inRound) logRoundMember(entry, draft);
            else void logSet(draft, entry);
          })
        }
        onOpenPad={(kind) => openPad(kind, false, memberKeyFor(entry))}
      />
      </>
    );
  };

  // ---- the keys ------------------------------------------------------------

  /** The newest live set of what is on screen: this entry's, or either
   *  member's in a round. */
  const scopeNewestSet = newestOf(
    focusSupersetPair
      ? [...setsForEntry(focusSupersetPair[0]), ...setsForEntry(focusSupersetPair[1])]
      : focusEntry
        ? setsForEntry(focusEntry)
        : [],
  );
  /** A rest is running for a set that was just saved: RPE, Note and Fix last
   *  then refer to THAT set (the panel above the dock says LAST SET), not to
   *  the next one being staged (M1, M2). */
  const midRoundSet =
    roundView?.nowIndex === 1 &&
    roundView.states[0] === "done" &&
    focusSupersetPair &&
    scopeNewestSet &&
    setsForEntry(focusSupersetPair[0]).some((x) => x.id === scopeNewestSet.id)
      ? scopeNewestSet
      : null;
  const restedSet = rest !== null ? lastSet : midRoundSet;
  const keyTargetSet = restedSet ?? scopeNewestSet;
  const stagedRpe = nowEntry ? draftOf(nowEntry).rpe : null;

  // The Swap key names the member it acts on: the round's NOW member in a
  // superset ("Swap A2"), the focus entry otherwise.
  const swapKeyEntry = focusSupersetPair ? nowEntry : focusEntry;
  const swapKeyTag = focusSupersetPair && swapKeyEntry
    ? ` ${supersetInfo.get(swapKeyEntry.key)?.tag ?? ""}`.trimEnd()
    : "";
  const focusKeys: FocusKeys = {
    onRpe: () => setRpeSheetOpen(true),
    rpeValue: restedSet ? (restedSet.rpe ?? null) : stagedRpe,
    onNote: keyTargetSet ? () => setNoteFor(keyTargetSet.id) : null,
    fourth:
      swapKeyEntry && scopeNewestSet === null && !swapFrozen(swapKeyEntry)
        ? {
            label: `${swapKeyEntry.substitutedFor ? "Swap again" : "Swap"}${swapKeyTag}`,
            onPress: () => openSheet("swap", swapKeyEntry.key),
          }
        : keyTargetSet
          ? { label: "Fix last", onPress: () => startCorrection(keyTargetSet) }
          : null,
  };

  // ---- the rest scene ------------------------------------------------------

  const adjustRest = (d: number) => {
    if (!rest) return;
    const targetSeconds = Math.max(0, rest.targetSeconds + d);
    setRest({ ...rest, targetSeconds });
    mirrorRest(targetSeconds, rest.forLabel);
    // the closed-app alert follows the target
    armRestAlert(rest.startedAt + targetSeconds * 1000, rest.forLabel);
  };

  const lastSetLine = (s: SetInsert): string => {
    const holder = entryOfSet(s);
    const name = holder
      ? (holder.substitutedFor && s.exercise_id === holder.substitutedFor.exercise_id
          ? holder.substitutedFor.name
          : holder.name)
      : "Last set";
    return `${name} · ${positionOfSet(s).text} · ${lineForSet(s)}`;
  };

  const loadNextView = nowEntry ? viewFor(nowEntry, draftOf(nowEntry)) : null;
  const focusRestSlot = rest ? (
    <>
      <RestTimer
        variant="panel"
        rest={rest}
        onAdjust={adjustRest}
        onEdit={() => openPad("rest")}
        nextSetLabel={nextSetLabel()}
      />
      {lastSet && (
        <RestLastSetCard
          line={lastSetLine(lastSet)}
          receipt={receiptFor(lastSet.id, true)}
          pairNote={pairNoteFor(lastSet.id)}
          onFix={() => startCorrection(lastSet)}
        />
      )}
      {nowEntry &&
        !entryDone(nowEntry) &&
        loadNextView?.style === "plates" &&
        loadNextView.plateSplit &&
        loadNextView.baseKnown && (
          <button
            type="button"
            className="focus-load-next"
            onClick={() => openSheet("plates", memberKeyFor(nowEntry))}
          >
            <PlateDiagram split={loadNextView.plateSplit} unit={unit} compact />
            <span>
              <span className="focus-card-eyebrow">LOAD NEXT</span>
              <span className="focus-load-next-text">
                {plateText(loadNextView.plateSplit, loadNextView.baseKg, unit, loadNextView.baseName)}
              </span>
            </span>
          </button>
        )}
    </>
  ) : null;

  const nextSetTag = (() => {
    if (focusRoundHeading) return `NEXT SET · ${focusRoundHeading.subtitle.toUpperCase()}`;
    if (!nowEntry || !nowDraft) return "NEXT SET";
    // a finished or skipped exercise has no next set: the tag must not claim one
    if (entryDone(nowEntry)) return "RESTING";
    const position = nextPositionText(nowEntry, nowDraft);
    return position === null ? "NEXT SET" : `NEXT SET · ${position.toUpperCase()}`;
  })();
  const focusDockTag =
    rest && !workoutDone ? (
      <RestDockTag
        rest={rest}
        label={nextSetTag}
        onEndNow={(elapsed) => {
          // a deliberate end is the lifter's own act: no tone, no buzz for it
          silenceRestCue(rest.startedAt);
          const targetSeconds = Math.max(0, elapsed);
          setRest({ ...rest, targetSeconds });
          mirrorRest(targetSeconds, rest.forLabel);
          disarmRestAlert();
        }}
      />
    ) : null;

  // ---- the middle band -----------------------------------------------------

  const roundMiddle = (() => {
    if (!focusSupersetPair || !roundView || !nowEntry || !nowDraft) return null;
    const pair = focusSupersetPair;
    const tags = [
      supersetInfo.get(pair[0].key)?.tag ?? "A1",
      supersetInfo.get(pair[1].key)?.tag ?? "A2",
    ] as const;
    const cardLine = (member: ExerciseEntry): string => {
      const d = draftOf(member);
      const v = viewFor(member, d);
      const load = stagedDisplayLoad(d.entryKg, d.enteredLoad, d.enteredUnit, unit);
      return v.noLoad
        ? `${d.reps} reps`
        : `${load} ${unit}${v.perSide ? " each" : ""} × ${d.reps}`;
    };
    const going = roundView.nowIndex;
    const other = going === 0 ? 1 : 0;
    const otherState = roundView.states[other];
    const hint = roundView.tail
      ? `${tags[other]} is ${otherState === "skipped" ? "skipped" : "finished"}. ${tags[going]} carries on, with a rest after each set.`
      : going === 1 && otherState === "done"
        ? `${tags[0]} logged. Log ${tags[1]} now, no rest between. Rest comes after.`
        : going === 1
          ? `${tags[1]} first this round. ${tags[0]} still to go. Rest comes after the round.`
          : otherState === "done"
            ? `${tags[1]} is already ahead. Log ${tags[0]} to catch up.`
            : `Log ${tags[0]}, then go straight to ${tags[1]}. Rest comes after.`;
    const card = (i: 0 | 1): RoundMemberCard => ({
      tag: tags[i],
      name: pair[i].name,
      line: cardLine(pair[i]),
      state: roundView.states[i],
      onChoose:
        roundView.states[i] === "now" ||
        roundView.states[i] === "skipped" ||
        roundView.tail
          ? undefined
          : () => setRoundNowOverride(pair[i].key),
      onUnskip:
        roundView.states[i] === "skipped"
          ? () => toggleSkip(pair[i])
          : undefined,
    });
    return {
      heading: `${tags[0]} THEN ${tags[1]} · REST AFTER ${tags[1]}`,
      cards: [card(0), card(1)] as [RoundMemberCard, RoundMemberCard],
      hint,
      tag: tags[going],
    };
  })();

  const focusPicture = roundMiddle && nowEntry && nowDraft ? (
    <SupersetRound
      heading={roundMiddle.heading}
      members={roundMiddle.cards}
      hint={roundMiddle.hint}
      picture={pictureFor(nowEntry, nowDraft, roundMiddle.tag)}
      unit={unit}
    />
  ) : (() => {
    if (!nowEntry || !nowDraft) return null;
    if (isTick(nowEntry))
      return <p className="focus-tick-help">Nothing to count. Tap Done after each set.</p>;
    const model = pictureFor(nowEntry, nowDraft);
    return model ? <LoadPicture model={model} unit={unit} /> : null;
  })();

  const warmupChoice =
    nowEntry && nowDraft && warmupSets(nowEntry) > 0 && !isTick(nowEntry)
      ? {
          staged: (nowDraft.setType === "warmup" ? "warmup" : "working") as "warmup" | "working",
          onChange: (next: "warmup" | "working") =>
            draftChangeFor(nowEntry)({ setType: next }),
          onAlreadyWarm:
            nowDraft.setType === "warmup"
              ? () => draftChangeFor(nowEntry)({ setType: "working" })
              : undefined,
        }
      : null;
  // A mixed entry's warmup counts its own warmups: "SET 1 OF 2 · WARMUP".
  const focusWarmupPosition =
    focusEntry &&
    !focusSupersetPair &&
    nowDraft?.setType === "warmup" &&
    workingSets(focusEntry) > 0
      ? (() => {
          const planned = warmupSets(focusEntry);
          const number = warmupCount(focusEntry) + 1;
          return { number, of: Math.max(planned, number) };
        })()
      : null;

  // ---- sheets and overlays -------------------------------------------------

  const inFocusDeck =
    presentation === "focus" && focusEligible && focusEntry !== null;

  // The ☰ n/m count: sets done over sets the plan asks for. Progress is
  // capped at each entry's own target so an extra set cannot push the count
  // past the total, entries with no plan (extras) are in neither number, and
  // a SKIPPED exercise leaves both: the day reads complete when everything
  // that is still to be done is done (L6).
  const headerEntries = entries.filter((e) => !(e.key in skips));
  const headerTotal = headerEntries.reduce((n, e) => n + targetSets(e), 0);
  const headerDone = headerEntries.reduce(
    (n, e) => n + Math.min(entryProgress(e), targetSets(e)),
    0,
  );

  /** A roll-up of the receipts of an exercise's sets, for its row in Today's
   *  workout: the first thing that needs attention wins. */
  const receiptMark = (members: readonly ExerciseEntry[]) => {
    const kinds = members
      .flatMap((entry) => setsForEntry(entry))
      .map((set) => receiptKindOf(set.id).kind);
    if (kinds.length === 0) return null;
    const order: ReceiptKind[] = ["review", "held", "sending", "local", "synced"];
    const kind = order.find((k) => kinds.includes(k)) ?? "synced";
    const words: Record<ReceiptKind, string> = {
      review: "Some sets need review",
      held: "Some sets are held for their account",
      sending: "Sets are sending",
      local: "Some sets are on this phone, waiting to send",
      synced: "All sets saved to the server",
    };
    return { glyph: RECEIPT_GLYPH[kind], label: words[kind] };
  };

  const unitNote = unit !== deviceUnit ? `${unit} this session · Settings says ${deviceUnit}` : null;

  /** What the RPE key rates: the set just saved while a rest runs, else the
   *  set being staged. The sheet's title says which. */
  const rpeSheet = (() => {
    if (!rpeSheetOpen || !nowEntry || !nowDraft) return null;
    const scopeEntries = focusSupersetPair ?? (focusEntry ? [focusEntry] : []);
    const rows = scopeEntries.map((entry) => (
      <div key={entry.key}>
        {scopeEntries.length > 1 && (
          <div className="rpe-sheet-subheading">
            {supersetInfo.get(entry.key)?.tag} · {entry.name}
          </div>
        )}
        {renderLoggedRows(entry)}
      </div>
    ));
    const hasRows = scopeEntries.some((entry) => setsForEntry(entry).length > 0);
    const target = restedSet;
    return (
      <RpeSheet
        title={
          target
            ? `Rate ${positionOfSet(target).text}, just saved`
            : roundMiddle
              ? `RPE for ${roundMiddle.tag}`
              : "RPE for the next set"
        }
        question={
          target
            ? `How hard was ${lastSetLine(target)}? Optional; blank is fine.`
            : "How hard will this set be? Optional; blank is fine."
        }
        value={target ? (target.rpe ?? null) : nowDraft.rpe}
        onChange={(next) => {
          if (target) void rateSet(target, next);
          else draftChangeFor(nowEntry)({ rpe: next });
        }}
        loggedHeading={`Logged for ${scopeEntries.map((e) => e.name).join(" and ")}`}
        loggedRows={hasRows ? rows : null}
        onMore={() => {
          setRpeSheetOpen(false);
          setMoreOpen(true);
        }}
        onClose={() => setRpeSheetOpen(false)}
      />
    );
  })();

  const noteTargetSet = noteFor ? (sets.find((s) => s.id === noteFor) ?? null) : null;
  const noteSheet = noteTargetSet ? (
    <NoteSheet
      key={noteTargetSet.id}
      title={`Note on ${positionOfSet(noteTargetSet).text}`}
      initial={setNotes[noteTargetSet.id] ?? ""}
      onSave={(note) => {
        void saveNote(noteTargetSet.id, note).then((ok) => {
          if (ok) setNoteFor(null);
        });
      }}
      onClose={() => setNoteFor(null)}
    />
  ) : null;

  const correctionSheet = editing ? (() => {
    const view = {
      perSide: editing.loadEntry === "per_side",
      maxEntryKg: editing.loadEntry === "per_side" ? MAX_LOAD_KG / 2 : MAX_LOAD_KG,
    };
    const position = positionOfSet(editing.set);
    const bodyweightNoLoad =
      isBodyweightEquipment(editing.equipment) && editing.set.load_kg === 0 && editing.entryKg === 0;
    return (
      <CorrectionSheet
        title={`Fix ${position.text}`}
        summary={`${editing.name} · logged ${lineForSet(editing.set)}`}
        unit={unit}
        perSide={view.perSide}
        showReps={editing.tracking !== "time"}
        load={
          bodyweightNoLoad
            ? null
            : {
                display: stagedDisplayLoad(
                  editing.entryKg,
                  editing.enteredLoad,
                  editing.enteredUnit,
                  unit,
                ),
                entryKg: editing.entryKg,
                maxEntryKg: view.maxEntryKg,
                steps: loadSteps(editing.set.exercise_id, unit),
              }
        }
        reps={editing.reps}
        setType={editing.setType}
        rpe={editing.rpe}
        onLoadChange={(entryKg) =>
          setEditing((prior) =>
            prior
              ? {
                  ...prior,
                  entryKg,
                  enteredLoad: toDisplay(entryKg, unit),
                  enteredUnit: unit,
                  loadEdited: true,
                }
              : prior,
          )
        }
        onRepsChange={(next) => setEditing((prior) => (prior ? { ...prior, reps: next } : prior))}
        onSetType={(next) => setEditing((prior) => (prior ? { ...prior, setType: next } : prior))}
        onRpe={(next) => setEditing((prior) => (prior ? { ...prior, rpe: next } : prior))}
        onOpenPad={(kind) => openPad(kind, false, null, true)}
        onSave={() => void saveCorrection()}
        onCancel={cancelCorrection}
        saving={editing.saving}
      />
    );
  })() : null;

  // ---- everything the plain screen leaves out, for the More sheet ----------

  /** Target, last time, and swap — the context the dock deliberately omits. */
  const contextBlock = (entry: ExerciseEntry) => {
    const prescribed = entry.brackets.length > 0;
    const draft = draftOf(entry);
    const view = viewFor(entry, draft);
    const last = lastTime(entry.exercise_id, view.mode);
    return (
      <>
        <span className="rx-context">
          {prescribed ? (
            <>
              TARGET {scheme(entry).toUpperCase()}
              {entry.brackets.length > 1 && view.bracket
                ? ` · NOW ${formatRepRange(view.bracket.reps_min, view.bracket.reps_max)} REPS`
                : ""}
              {view.bracket?.rest_seconds != null
                ? ` · REST ${formatClock(view.bracket.rest_seconds)}`
                : ""}
              {entry.brackets.some(rxHasNoTm) ? " · NO TM SET" : ""}
            </>
          ) : (
            `NO TARGET · BY FEEL${view.equipment ? ` · ${view.equipment.toUpperCase()}` : ""}`
          )}
        </span>

        {/* "Last time" is the CHOSEN movement's own history: `lastActuals` is
            keyed by exercise, so a swap moves this line with it and never
            quotes the planned movement's numbers at a different one. */}
        {last && <div className="microcopy">{last}</div>}

        {entry.substitutedFor && (
          <div className="microcopy swap-note">
            Instead of {entry.substitutedFor.name}. The plan’s target still
            counts here.
            {swapFrozen(entry) ? " Sets are logged against it, so it stays." : ""}
          </div>
        )}

        {/* Only while nothing has been logged against the swap: those sets
            name the chosen exercise and are append-only, so there is nothing
            left here to undo — see `swapFrozen`. */}
        {!swapFrozen(entry) && (
          <div className="swap-actions">
            <button
              type="button"
              className="swap-action"
              onClick={() => {
                setMoreOpen(false);
                openSheet("swap", entry.key);
              }}
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
  };

  /** Warmup/working, how-to, the plate calculator, the per-hand toggle, skip:
   *  everything the dock shows nowhere else, for ONE entry. */
  const moreExtrasFor = (target: ExerciseEntry) => {
    const skipped = Boolean(skips[target.key]);
    const skipAction = (
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => toggleSkip(target)}
      >
        {skipped ? "UNSKIP" : "SKIP"}
      </button>
    );
    const howToAction = (
      <button
        type="button"
        className="btn btn-ghost"
        aria-label={`how to do ${target.name}`}
        onClick={() => {
          setDemoFor({ id: target.exercise_id, name: target.name });
          setMoreOpen(false);
        }}
      >
        How to
      </button>
    );
    if (isTick(target)) {
      return (
        <div className="focus-more-actions">
          {howToAction}
          {skipAction}
        </div>
      );
    }
    const draft = draftOf(target);
    const view = viewFor(target, draft);
    return (
      <div className="focus-more-extras">
        <div className="seg seg-types" role="group" aria-label="Set type">
          {(["warmup", "working"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`seg-btn ${draft.setType === t ? "seg-on" : ""}`}
              aria-pressed={draft.setType === t}
              onClick={() => draftChangeFor(target)({ setType: t })}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="focus-more-actions">
          {howToAction}
          {view.style === "plates" && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setMoreOpen(false);
                openSheet("plates", memberKeyFor(target));
              }}
            >
              Plate calculator
            </button>
          )}
          {view.canToggleEntry && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => toggleLoadEntryFor(target, view.mode)}
            >
              {view.perSide ? "each hand" : "one total weight"}
            </button>
          )}
          {view.canSwitchStyle && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => toggleLoadStyleFor(target, view.style)}
            >
              {view.style === "plates" ? "switch to weight stack" : "switch to plates"}
            </button>
          )}
          {skipAction}
        </div>
      </div>
    );
  };

  // ---- render --------------------------------------------------------------

  if (sessionId && !prefsReady) {
    return <div className="session-shell" role="status">Loading workout choices…</div>;
  }

  /** the open List card: its logged sets, then what is left to do */
  const renderCurrent = (entry: ExerciseEntry) => {
    const skipped = Boolean(skips[entry.key]);
    const complete = entryDone(entry) && !skipped;
    const removable = entry.brackets.length === 0 && setsForEntry(entry).length === 0;
    return (
      <>
        {renderLoggedRows(entry)}
        {roundMiddle && inLiveRound(entry) && (
          <SupersetRound
            heading={roundMiddle.heading}
            members={roundMiddle.cards}
            hint={roundMiddle.hint}
            picture={null}
            unit={unit}
          />
        )}
        {skipped ? (
          <button type="button" className="btn btn-outline-ink btn-block" onClick={() => toggleSkip(entry)}>
            Unskip
          </button>
        ) : complete && !extraSetArmed ? (
          <div className="focus-complete">
            <div className="focus-complete-title">All planned sets logged.</div>
            <button type="button" className="focus-chip-btn" onClick={() => setExtraSetArmed(true)}>
              + Extra set
            </button>
          </div>
        ) : (
          <div className="wk-list-dock">
            {rest && <div className="wk-list-next-tag">{nextSetTag}</div>}
            {renderDock(
              <DockKeys
                keys={focusKeys}
                skip={{ label: "Skip", onPress: () => skipEntryWithReason(entry, null) }}
              />,
            )}
          </div>
        )}
        {removable && (
          <button
            type="button"
            className={`drawer-action ${dropArm === entry.key ? "drawer-action-armed" : ""}`}
            onClick={() => {
              if (dropArm === entry.key) {
                setDropArm(null);
                void removeExtra(entry);
              } else setDropArm(entry.key);
            }}
          >
            {dropArm === entry.key ? "UNDO ADD?" : "UNDO ADD"}
          </button>
        )}
      </>
    );
  };

  return (
    <div className="session-shell">
      <SessionHeaderPortal>
        <SessionHeaderControls
          done={headerDone}
          total={headerTotal}
          presentation={presentation}
          focusEligible={focusEligible}
          onOpenWorkout={() => setWorkoutSheetOpen(true)}
          onFocus={enterFocus}
          onList={showOverview}
        />
      </SessionHeaderPortal>

      {workoutSheetOpen && (
        <TodayWorkoutSheet
          blocks={blocks}
          unit={unit}
          deviceUnit={deviceUnit}
          onUnitChange={switchWorkoutUnit}
          unitDisabled={!prefsReady || !identityOwner}
          entryProgress={entryProgress}
          entryState={entryState}
          formatScheme={scheme}
          receiptMark={receiptMark}
          onSelect={jumpToEntry}
          onMoveBlock={moveBlock}
          canMoveBlock={canMoveBlock}
          reorderLocked={reorderLocked}
          hasSections={hasSections}
          supersetInfo={supersetInfo}
          selectedKey={nowEntry?.key ?? null}
          onAddExercise={() => {
            setWorkoutSheetOpen(false);
            openSheet("search");
          }}
          onHome={() => {
            setWorkoutSheetOpen(false);
            goHome();
          }}
          onFinish={finishWorkout}
          onClose={() => setWorkoutSheetOpen(false)}
        />
      )}

      <div className="session-scroll">
        {/* Session notes move to the top of the "more" sheet in focus mode —
            see below — so the default screen stays to the hero and LOG. */}
        {!inFocusDeck && (active.plan_note || active.coach_note) && (
          <div className="session-notes">
            {active.plan_note && <Note label="PLAN NOTE" text={active.plan_note} />}
            {active.coach_note && <Note label="COACH" text={active.coach_note} />}
          </div>
        )}

        <section className={inFocusDeck ? "focus-shell" : "rule-section"}>
          {!inFocusDeck && (
            <div className="section-head">
              {/* the screen's h1: the workout being logged */}
              <h1 className="field-label">
                {active.workout_label ? active.workout_label.toUpperCase() : "WORKOUT"}
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
              key={(nowEntry ?? focusEntry).key}
              entries={orderedEntries}
              entry={nowEntry ?? focusEntry}
              entryProgress={entryProgress}
              entryDone={entryDone}
              onChooseNext={jumpToEntry}
              canAdvance={focusSupersetPair === null}
              renderEditor={(_entry, keys) => renderDock(keys)}
              formatScheme={scheme}
              workoutComplete={workoutDone}
              extraSetArmed={extraSetArmed}
              onFinishWorkout={finishWorkout}
              onAddExtraSet={() => setExtraSetArmed(true)}
              supersetHeading={focusRoundHeading}
              picture={focusPicture}
              cue={nowEntry?.substitutedFor ? null : (nowView?.bracket?.notes ?? null)}
              lastTime={
                nowEntry && nowView && !isTick(nowEntry) && !roundMiddle
                  ? lastTime(nowEntry.exercise_id, nowView.mode, true, nowView.noLoad)
                  : null
              }
              restSlot={focusRestSlot}
              dockTag={focusDockTag}
              keys={focusKeys}
              warmupPosition={focusWarmupPosition}
              warmupChoice={warmupChoice}
              unitNote={unitNote}
              onOpenMore={() => setMoreOpen(true)}
              onSkip={(reason) => skipEntryWithReason(nowEntry ?? focusEntry, reason)}
              skipped={Boolean((nowEntry ?? focusEntry).key in skips)}
              skipReason={skips[(nowEntry ?? focusEntry).key]?.reason ?? null}
              onUnskip={() => toggleSkip(nowEntry ?? focusEntry)}
            />
          ) : (
            <>
              {!focusEligible && entries.length > 0 && (
                <p className="microcopy focus-unavailable">
                  {overviewOnlyCircuit
                    ? `This workout opens in List because Superset ${supersetLetter(overviewOnlyCircuit[0]?.brackets[0]?.superset_group ?? 1)} has ${overviewOnlyCircuit.length} exercises.`
                    : "This workout stays in the full view."}
                </p>
              )}
              <WorkoutOverview
                entries={orderedEntries}
                currentKey={nowEntry?.key ?? null}
                entryState={entryState}
                entryProgress={entryProgress}
                isSkipped={(entry) => Boolean(skips[entry.key])}
                hasSections={hasSections}
                supersetInfo={supersetInfo}
                formatScheme={scheme}
                onJump={jumpToEntry}
                restSlot={
                  rest ? (
                    <RestTimer
                      variant="strip"
                      rest={rest}
                      onAdjust={adjustRest}
                      onEdit={() => openPad("rest")}
                      /* dismissing hides the strip only: the clock keeps
                         measuring, so the mirror keeps its startedAt with a
                         null target — and a strip nobody wants to see is a
                         buzz nobody wants either */
                      onDone={() => {
                        setRest(null);
                        mirrorRest(null, null);
                        disarmRestAlert();
                      }}
                      nextSetLabel={nextSetLabel()}
                    />
                  ) : null
                }
                renderCurrent={renderCurrent}
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

      {!inFocusDeck && (
        <div className="session-footer">
          <button
            type="button"
            className="btn btn-ghost"
            aria-label="back to Today — session keeps running"
            onClick={goHome}
          >
            Home
          </button>
          <button type="button" className="btn btn-outline-ink" onClick={finishWorkout}>
            Finish
          </button>
        </div>
      )}

      {sheet === "outbox" && (
        <OutboxSheet
          receiptReviewReason={receiptReviewReason}
          onClose={() => { setSheet(null); setReceiptReviewReason(null); }}
        />
      )}

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
      {sheet === "swap" && (swapTarget ?? openEntry) && (
        <ExercisePicker
          title="SWAP EXERCISE"
          exercises={allExercises}
          failed={exercisesFailed}
          onPick={(ex) => swapExercise((swapTarget ?? openEntry)!, ex)}
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
          startKg={lastActuals[declaring.id]?.load_kg ?? getPrefillFallback().loadKg}
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
          targetKg={viewFor(plateEntry, draftOf(plateEntry)).totalLoadKg}
          unit={unit}
          equipment={equipMap[plateEntry.exercise_id] ?? null}
          onTypeTarget={() => openPad("load", true, roundInputEntry?.key ?? null)}
          onTypeBase={() => openPad("base", true, roundInputEntry?.key ?? null)}
          onClose={() => {
            setSheet(null);
            setRoundInputKey(null);
          }}
        />
      )}

      {rpeSheet}
      {noteSheet}
      {correctionSheet}

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
              {active.plan_note && <Note label="PLAN NOTE" text={active.plan_note} />}
              {active.coach_note && <Note label="COACH" text={active.coach_note} />}
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
              role="group"
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
              {contextBlock(target)}
              {renderLoggedRows(target) && (
                <section className="rule-section">
                  <div className="section-head">
                    <span className="field-label">LOGGED</span>
                    <span className="section-meta">
                      {entryProgress(target)}
                      {target.brackets.length > 0 ? ` OF ${targetSets(target)}` : ""}
                    </span>
                  </div>
                  {renderLoggedRows(target)}
                </section>
              )}
              {moreExtrasFor(target)}
            </div>
          ))}
        </FocusMoreSheet>
      )}

      {leavePromptOpen && (
        <Sheet
          title="Unlogged set changes"
          onClose={() => setLeavePromptOpen(false)}
        >
          <p className="microcopy">
            Set values you haven’t logged, including an edit in progress, are
            held only on this screen. Stay to keep them, or leave to discard
            them.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => setLeavePromptOpen(false)}
          >
            Stay in session
          </button>
          <button
            type="button"
            className="btn btn-danger btn-block"
            onClick={() => {
              setLeavePromptOpen(false);
              navigate("/");
            }}
          >
            Leave and discard drafts
          </button>
        </Sheet>
      )}

      {req && <NumberPad req={req} />}
    </div>
  );
}
