// The two day-shaped pieces of History: the week in one line, and the log of
// finished sessions. Both are presentational — History owns the fetching, the
// caching and the outbox subtraction, the way it already does for the charts.
//
// A session row answers "what did I do on Tuesday" at a glance (date, the
// plan's own name for the day, how long, how many sets, sRPE) and answers it
// properly when opened: every set of every movement, in the order it
// happened, with the loads read back the way they were entered.

import { SetRow } from "./SetRow";
import {
  describeWeek,
  groupSetsByExercise,
  sessionSeconds,
  type SessionLogEntry,
  type WeeklySummaryRow,
} from "../lib/sessionHistory";
// The same formatter End uses for the session it is closing. A session's
// length must read identically in both places: this repo has already had
// three hand-rolled target formatters drift into three different apps.
import { formatDuration } from "../screens/End";
import { formatSessionDate } from "../lib/format";
import type { Unit } from "../lib/units";
import type { SetInsert } from "../lib/types";

interface WeekLineProps {
  row: WeeklySummaryRow | null;
  unit: Unit;
  loading: boolean;
}

/** Sessions, working sets, tonnage, and planned vs done — one line. */
export function WeekLine({ row, unit, loading }: WeekLineProps) {
  if (loading && row === null) return <p className="muted">Loading…</p>;
  const week = describeWeek(row, unit);
  if (week.idle)
    return (
      <p className="muted">Nothing this week yet — no sessions, no plan.</p>
    );
  return (
    <div className="week-line">
      <span className="week-line-effort">{week.effort}</span>
      {/* Two counts, never a ratio. A week with no plan prints nothing here
          at all: 0% would read as total failure where the truth is that
          nothing was asked for. */}
      {week.plan !== null && (
        <span className="week-line-plan">{week.plan}</span>
      )}
    </div>
  );
}

interface SessionListProps {
  sessions: SessionLogEntry[];
  loading: boolean;
  unit: Unit;
  /** the row that is open, if any */
  openId: string | null;
  onToggle: (sessionId: string) => void;
  /** sets of the open session; undefined while they are still being read */
  openSets: SetInsert[] | undefined;
  /** exercise id -> name; a missing id renders as the raw id rather than
   *  blank, because a set that happened must never render as nothing */
  exerciseName: (id: string) => string;
}

/** One row per finished session, newest first; tapping opens that day. */
export function SessionList({
  sessions,
  loading,
  unit,
  openId,
  onToggle,
  openSets,
  exerciseName,
}: SessionListProps) {
  if (sessions.length === 0)
    return (
      <p className="muted">
        {loading ? "Loading…" : "No finished sessions yet."}
      </p>
    );

  return (
    <div className="log-list">
      {sessions.map((s) => {
        const open = s.id === openId;
        const seconds = sessionSeconds(s);
        const meta = [
          seconds === null ? null : formatDuration(seconds),
          `${s.setCount} ${s.setCount === 1 ? "SET" : "SETS"}`,
          s.session_rpe === null ? null : `sRPE ${s.session_rpe}`,
        ].filter((p): p is string => p !== null);
        return (
          <div key={s.id} className={`log-item ${open ? "log-item-on" : ""}`}>
            <button
              type="button"
              className="log-row"
              aria-expanded={open}
              onClick={() => onToggle(s.id)}
            >
              <span className="log-date">
                {formatSessionDate(s.started_at)}
              </span>
              {/* an unplanned session has no name; the date is the name */}
              <span className="log-name">{s.label ?? "Unplanned session"}</span>
              <span className="log-meta">{meta.join(" · ")}</span>
              <span className="chev" aria-hidden="true">
                {open ? "▴" : "▾"}
              </span>
            </button>
            {open && (
              <div className="log-open">
                {openSets === undefined && <p className="muted">Loading…</p>}
                {openSets !== undefined && openSets.length === 0 && (
                  // the count on the row came from the same view, so this is
                  // a session whose sets have since been voided one by one —
                  // rare, and still the truth about that day
                  <p className="muted">No sets left in this session.</p>
                )}
                {openSets !== undefined &&
                  groupSetsByExercise(openSets).map((run, i) => (
                    <div
                      key={`${run.exerciseId}-${i}`}
                      className="log-exercise"
                    >
                      <div className="log-exercise-name">
                        {exerciseName(run.exerciseId)}
                      </div>
                      {run.sets.map((set) => (
                        <SetRow key={set.id} set={set} unit={unit} />
                      ))}
                    </div>
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
