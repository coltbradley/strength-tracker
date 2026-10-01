import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { groupRamps } from "../lib/entries";
import type { Unit } from "../lib/units";
import type {
  ActiveSession,
  PlannedWorkoutRow,
  ResolvedPrescriptionRow,
} from "../lib/types";
import { formatPlannedDate, formatRxTarget } from "../lib/format";
import { WorkoutPreviewSheet } from "./WorkoutPreviewSheet";

export type TrainWorkoutState =
  | "DONE"
  | "SKIPPED"
  | "TODAY"
  | "MISSED"
  /** a past day whose completion this device could not check: not knowing is
   *  not failing, so it is never worded as MISSED */
  | "PAST"
  | "UPCOMING"
  | "NO DATE"
  | "DRAFT";

/** What one day of the Train week strip is, in the app's own state words. */
export type TrainDayState = TrainWorkoutState | "REST";

export interface TrainWeekDay {
  iso: string;
  /** one-letter weekday, "M" */
  letter: string;
  /** spoken name, "Wednesday 30" */
  name: string;
  state: TrainDayState;
  isToday: boolean;
}

/**
 * The short word under each day. Derived from the SAME state the Program
 * strip uses, never recomputed: a DRAFT is DRAFT (never missed) and DONE
 * already means the session has `ended_at`.
 */
export function trainDayWord(state: TrainDayState): string {
  switch (state) {
    case "DONE":
      return "DONE";
    case "SKIPPED":
      return "SKIP";
    case "TODAY":
      return "TODAY";
    case "UPCOMING":
      return "NEXT";
    case "DRAFT":
      return "DRAFT";
    case "REST":
      return "REST";
    case "MISSED":
      return "MISSED";
    case "PAST":
      return "PAST";
    default:
      return "";
  }
}

const DAY_GLYPH: Record<TrainDayState, string> = {
  DONE: "✓",
  SKIPPED: "–",
  TODAY: "●",
  UPCOMING: "○",
  DRAFT: "…",
  REST: "·",
  MISSED: "!",
  PAST: "○",
  "NO DATE": "○",
};

/** The spoken state for a strip cell. PAST says it was not checked. */
function daySpoken(state: TrainDayState): string {
  switch (state) {
    case "UPCOMING":
      return "upcoming";
    case "SKIPPED":
      return "skipped";
    case "PAST":
      return "past, completion not checked";
    case "NO DATE":
      return "no date";
    default:
      return trainDayWord(state).toLowerCase();
  }
}

/**
 * What the confirmation may say about the server. Every field is about SET
 * writes on this phone's outbox; other writes (session end, voids, notes,
 * bodyweight) are counted apart and never called sets. `null` for the whole
 * object = say nothing.
 */
export interface TrainSyncSummary {
  /** the outbox has been read at least once; false = "checking…" */
  checked: boolean;
  /** who is signed in is known. Unknown identity holds every queued write. */
  identityKnown: boolean;
  /** set writes queued on THIS phone that it will send */
  waiting: number;
  /** set writes this phone will NOT send (other account, or no owner yet).
   *  They are not on the server. */
  held: number;
  /** set writes refused by the server and needing a look */
  dead: number;
  /** non-set writes still queued (waiting, held or dead) */
  otherPending: number;
  /** Stronger than the queue: each of this session's sets read back from the
   *  server by its exact UUID (the same receipt the Session screen shows).
   *  null = not read (offline, unknown owner, nothing cached): say only what
   *  the queue proves. */
  proof?: { sets: number; confirmed: number; unconfirmed: number } | null;
}

export interface TrainActiveProgress {
  /** sets logged so far; null while it cannot be known */
  setsDone: number | null;
  /** sets the plan prescribes for the day; null when the day has no plan rows */
  setsPlanned: number | null;
}

export interface TrainWorkout {
  workout: PlannedWorkoutRow;
  state: TrainWorkoutState;
}

export interface TrainWorkoutSummary {
  movementCount: number;
  prescribedSetCount: number;
  firstUp: string | null;
}

/**
 * The train surface counts movements the same way the session does: adjacent
 * ramp brackets are one movement, while every prescribed set remains a set.
 */
export function summarizeTrainWorkout(
  prescriptions: ResolvedPrescriptionRow[],
): TrainWorkoutSummary {
  const groups = groupRamps(prescriptions);
  return {
    movementCount: groups.length,
    prescribedSetCount: prescriptions.reduce(
      (total, row) => total + row.sets,
      0,
    ),
    firstUp: groups[0]?.[0]?.exercise_name ?? null,
  };
}

/** First movement and the one after it, each with its prescribed scheme. */
export function trainUpNext(
  prescriptions: ResolvedPrescriptionRow[],
  unit: Unit,
): { name: string; scheme: string }[] {
  return groupRamps(prescriptions)
    .slice(0, 2)
    .map((group) => ({
      name: group[0].exercise_name,
      scheme: group.map((r) => formatRxTarget(r, unit)).join(" · "),
    }));
}

/** An open session older than this is not "N MIN" any more. */
const LONG_OPEN_MIN = 12 * 60;

/** The in-progress kicker clock: minutes, or when it started once that is a
 *  claim nobody is timing ("1440 MIN" is a session left open overnight). */
export function inProgressClock(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "0 MIN";
  const mins = Math.max(0, Math.floor((now - t) / 60000));
  if (mins < LONG_OPEN_MIN) return `${mins} MIN`;
  const started = new Date(t);
  const sameDay = started.toDateString() === new Date(now).toDateString();
  if (sameDay)
    return `STARTED ${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (started.toDateString() === yesterday.toDateString())
    return "STARTED YESTERDAY";
  return `STARTED ${started
    .toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    .toUpperCase()}`;
}

/**
 * "all sets on the server" is a claim, so it needs proof: identity known, the
 * outbox read, and no set write waiting, held or dead. Anything less says what
 * IS true. Held counts as not on the server: a held write is queued on this
 * phone and will not be sent by it.
 */
export function syncLine(sync: TrainSyncSummary): string {
  if (!sync.checked) return "checking…";
  const parts: string[] = [];
  if (sync.dead > 0)
    parts.push(`${sync.dead} ${sync.dead === 1 ? "needs" : "need"} review`);
  const onPhone = sync.waiting + sync.held;
  if (onPhone > 0) parts.push(`${onPhone} waiting on this phone`);
  const proof = sync.proof ?? null;
  // A set the server did not return by UUID is not "on the server", whatever
  // an empty queue implies. Only when the queue itself is silent: otherwise
  // the same sets are already counted above.
  if (parts.length === 0 && proof && proof.unconfirmed > 0)
    parts.push(
      `${proof.unconfirmed} of ${proof.sets} ${proof.sets === 1 ? "set" : "sets"} not confirmed on the server`,
    );
  if (parts.length === 0) {
    if (!sync.identityKnown) return "checking…";
    parts.push(
      proof && proof.sets > 0
        ? `${proof.sets} ${proof.sets === 1 ? "set" : "sets"} confirmed on the server`
        : "all sets on the server",
    );
  }
  if (sync.otherPending > 0)
    parts.push(
      `${sync.otherPending} other ${sync.otherPending === 1 ? "change" : "changes"} waiting`,
    );
  return parts.join(" · ");
}

export function TrainHome({
  dateContext,
  programName,
  loading,
  loadIssue,
  stale,
  workout,
  prescriptions,
  prescriptionLoadState,
  active,
  recovery,
  startEnabled,
  completedToday,
  finishedToday = null,
  sync = null,
  otherPrograms = [],
  week = null,
  activeProgress = null,
  unit = "lb",
  onStart,
  onOpenCoach,
  onCheckIn,
}: {
  dateContext: string;
  programName: string | null;
  loading: boolean;
  loadIssue: "offline" | "error" | null;
  stale?: "offline" | "error" | null;
  workout: TrainWorkout | null;
  prescriptions: ResolvedPrescriptionRow[] | null;
  prescriptionLoadState:
    | "loading"
    | "loaded"
    | "offline"
    | "error"
    | "cached-offline"
    | "cached-error";
  active: ActiveSession | null;
  /** Recovery is owned by Today because it reconciles and repairs sessions. */
  recovery: ReactNode;
  startEnabled: boolean;
  completedToday?: boolean;
  /** Today's own workout, when its session has ended. Drives the confirmation. */
  finishedToday?: PlannedWorkoutRow | null;
  sync?: TrainSyncSummary | null;
  /** Confirmed programs this screen is NOT showing (undated ones beyond the
   *  first). Named so a second program is never silently hidden. */
  otherPrograms?: string[];
  /** Seven days of this week; null for a program with no dates. */
  week?: TrainWeekDay[] | null;
  activeProgress?: TrainActiveProgress | null;
  unit?: Unit;
  onStart: (workout: PlannedWorkoutRow) => void;
  onOpenCoach: () => void;
  onCheckIn?: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  // Only the in-progress card has a clock, so only it keeps one.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);
  const summary =
    prescriptions === null ? null : summarizeTrainWorkout(prescriptions);
  const upNext = prescriptions === null ? [] : trainUpNext(prescriptions, unit);
  const coachNote = workout?.workout.notes?.trim() || null;

  const shapeLine =
    summary === null ? null : (
      <p className="train-shape">
        {summary.movementCount}{" "}
        {summary.movementCount === 1 ? "movement" : "movements"} ·{" "}
        {summary.prescribedSetCount}{" "}
        {summary.prescribedSetCount === 1 ? "set" : "sets"}
      </p>
    );
  const detailStatus =
    summary === null ? (
      <p className="train-quiet">
        {prescriptionLoadState === "offline"
          ? "Workout details are unavailable offline. Refresh your plan to retry."
          : prescriptionLoadState === "error"
            ? "Couldn’t load workout details. Refresh your plan to retry."
            : "Workout details are loading."}
      </p>
    ) : prescriptionLoadState === "cached-offline" ||
      prescriptionLoadState === "cached-error" ? (
      <p className="train-cache-note" role="status">
        {prescriptionLoadState === "cached-offline"
          ? "Offline, showing saved workout details."
          : "Couldn’t refresh, showing saved workout details."}
      </p>
    ) : null;
  const goButton = (
    <button
      type="button"
      className="btn btn-primary btn-block train-go"
      disabled={!startEnabled}
      onClick={() => setPreviewOpen(true)}
    >
      Go
    </button>
  );
  // A DONE workout is, by the app's one definition, a session with ended_at.
  const finished =
    finishedToday ?? (workout?.state === "DONE" ? workout.workout : null);
  const confirmation = finished ? (
    <div className="train-finished" role="status">
      <span aria-hidden="true">✓</span>{" "}
      {finished.label ?? "Workout"} finished
      {sync ? ` · ${syncLine(sync)}` : ""}
    </div>
  ) : null;
  const planLink = (
    <Link className="train-link" to="/program">
      See the plan
    </Link>
  );
  const recordLink = completedToday || finished ? (
    <Link className="train-link" to="/history">
      View record
    </Link>
  ) : null;

  return (
    <section className="train-home" aria-label="Train">
      <div className="date-heading-row">
        <div className="train-date">{dateContext}</div>
        {onCheckIn && (
          <button type="button" className="checkin-link" onClick={onCheckIn}>
            Check in
          </button>
        )}
      </div>
      {week && (
        <nav className="train-week" aria-label="This week">
          {week.map((d) => {
            const word = trainDayWord(d.state);
            return (
              <Link
                key={d.iso}
                to="/program"
                className={`train-day train-day-${d.state
                  .toLowerCase()
                  .replace(" ", "-")}${d.isToday ? " train-day-today" : ""}`}
                aria-current={d.isToday ? "date" : undefined}
                aria-label={`${d.name}, ${daySpoken(d.state)}, open program`}
              >
                <span className="train-day-letter" aria-hidden="true">
                  {d.letter}
                </span>
                <span className="train-day-glyph" aria-hidden="true">
                  {DAY_GLYPH[d.state]}
                </span>
                <span className="train-day-word" aria-hidden="true">
                  {word}
                </span>
              </Link>
            );
          })}
        </nav>
      )}
      {otherPrograms.length > 0 && (
        <p className="train-note">
          Also confirmed, not shown here: {otherPrograms.join(", ")}.
        </p>
      )}
      {stale && (
        <p className="train-note" role="status">
          {stale === "offline"
            ? "○ Offline — showing the plan saved on this phone."
            : "! Couldn’t refresh. Showing the saved plan; logging works."}
        </p>
      )}

      {active ? (
        <div className="train-state">
          <div className="train-kicker">
            IN PROGRESS · {inProgressClock(active.started_at, now)}
          </div>
          <h1 className="train-title">
            {active.workout_label ?? workout?.workout.label ?? "Workout"}
          </h1>
          {/* Unknown (a failed read) shows nothing rather than a 0. The logged
              count includes warmups and extras, so it is not "n of m". */}
          {activeProgress && activeProgress.setsDone !== null && (
            <p className="train-shape">
              {activeProgress.setsDone}{" "}
              {activeProgress.setsDone === 1 ? "set" : "sets"} logged
              {activeProgress.setsPlanned !== null
                ? ` · ${activeProgress.setsPlanned} planned`
                : ""}
            </p>
          )}
          <Link className="btn btn-primary btn-block train-go" to="/session">
            Resume
          </Link>
        </div>
      ) : recovery ? (
        <div className="train-recovery">{recovery}</div>
      ) : loading ? (
        <p className="train-quiet">Loading your plan…</p>
      ) : loadIssue ? (
        <div className="train-state">
          <p className="train-quiet">
            {loadIssue === "offline"
              ? "Couldn’t load your plan while offline."
              : "Couldn’t load your plan. Try again when the connection is back."}
          </p>
          <Link className="train-link" to="/program">
            View program
          </Link>
        </div>
      ) : programName === null ? (
        <div className="train-state">
          <div className="train-kicker">START HERE</div>
          <h1 className="train-title">No program yet</h1>
          <p className="train-quiet">
            Build your plan in Program, or ask the coach to help write it.
          </p>
          <Link className="btn btn-primary btn-block train-go" to="/program">
            View program
          </Link>
          <button type="button" className="train-link" onClick={onOpenCoach}>
            Ask the coach
          </button>
        </div>
      ) : workout === null || workout.state === "DONE" ? (
        // Nothing left to do today. After a finished session this is where the
        // app CONFIRMS it, instead of calling the day a rest day and moving on.
        <div className="train-state">
          {confirmation}
          <div className="train-kicker train-kicker-dim">REST DAY</div>
          <h1 className="train-title">Recover.</h1>
          {workout === null && !finished && (
            <p className="train-quiet">Nothing is scheduled for today.</p>
          )}
          {planLink}
          {recordLink}
        </div>
      ) : workout.state === "DRAFT" ? (
        // A dated day nobody has filled in yet. It is not a rest day and
        // never a missed one: say what it is and send the way to fill it.
        <div className="train-state">
          <h1 className="train-title">{workout.workout.label ?? "Workout"}</h1>
          <p className="train-note">
            ○ Draft — nothing planned in it yet. Not a missed day.
          </p>
          <Link
            className="btn btn-secondary btn-block train-go"
            to={`/plan/${workout.workout.id}`}
          >
            Fill in this day
          </Link>
        </div>
      ) : workout.state === "UPCOMING" ? (
        <div className="train-state">
          {confirmation}
          <div className="train-kicker train-kicker-dim">REST DAY</div>
          <h1 className="train-title">Recover.</h1>
          <div className="train-next-workout">
            <span>NEXT · {formatPlannedDate(workout.workout.scheduled_date!)}</span>
            <strong>{workout.workout.label ?? "Workout"}</strong>
            {shapeLine}
          </div>
          {detailStatus}
          {goButton}
          {planLink}
          {recordLink}
        </div>
      ) : workout.state !== "TODAY" ? (
        <div className="train-state">
          <h1 className="train-title">Rest day</h1>
          <p className="train-quiet">Nothing is ready to start today.</p>
          <Link className="train-link" to="/program">
            View program
          </Link>
        </div>
      ) : (
        <div className="train-state">
          <div className="train-kicker">TODAY · {programName}</div>
          <h1 className="train-title">{workout.workout.label ?? "Workout"}</h1>
          {/* No "about N min": nothing in the plan or the log yields a
              duration we can stand behind, so none is shown. */}
          {shapeLine}
          {detailStatus}
          {upNext.length > 0 && (
            <div className="train-first-up">
              <span>FIRST UP</span>
              <strong>{upNext[0].name}</strong>
              <em>{upNext[0].scheme}</em>
              {upNext[1] && (
                <small>
                  then {upNext[1].name} · {upNext[1].scheme}
                </small>
              )}
            </div>
          )}
          {coachNote && (
            <div className="train-coach">
              <svg
                className="train-coach-icon"
                viewBox="0 0 16 16"
                width="16"
                height="16"
                aria-hidden="true"
              >
                <path
                  d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H7l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
              <p>
                <b>Coach</b> {coachNote}
              </p>
            </div>
          )}
          {goButton}
        </div>
      )}
      {previewOpen && workout && programName && (
        <WorkoutPreviewSheet
          workout={workout.workout}
          programName={programName}
          prescriptions={prescriptions}
          loadState={prescriptionLoadState}
          unit={unit}
          startEnabled={startEnabled}
          onClose={() => setPreviewOpen(false)}
          onStart={(selected) => {
            setPreviewOpen(false);
            onStart(selected);
          }}
        />
      )}
    </section>
  );
}
