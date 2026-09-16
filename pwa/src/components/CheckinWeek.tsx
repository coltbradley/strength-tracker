// Check-ins in History: a week of energy by time of day, a Monday-to-Sunday
// row beneath it, and the chosen day's check-ins in full.
import { useEffect, useMemo, useState } from "react";
import {
  addDaysIso,
  getInjuries,
  getWeekBuckets,
  getWeekCheckins,
  localDateOf,
  type BucketRow,
} from "../lib/checkinHistory";
import {
  BUCKETS,
  buildGrid,
  dayCounts,
  defaultDayIndex,
} from "../lib/checkinWeek";
import {
  impactLabel,
  injuryLabel,
  mergeCheckins,
  pendingCheckins,
  tagLabel,
} from "../lib/checkins";
import { weekStartIso } from "../lib/sessionHistory";
import { formatSessionDate } from "../lib/format";
import { outbox } from "../lib/sync";
import { reportError } from "../lib/errors";
import type { CheckinRow, InjuryState } from "../lib/types";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CheckinWeek({
  today,
  userId,
}: {
  today: string;
  userId: string;
}) {
  const currentWeek = weekStartIso(today);
  const [weekStart, setWeekStart] = useState(currentWeek);
  const [buckets, setBuckets] = useState<BucketRow[]>([]);
  const [checkins, setCheckins] = useState<CheckinRow[]>([]);
  const [injuries, setInjuries] = useState<InjuryState[]>([]);
  const [day, setDay] = useState(() => defaultDayIndex(currentWeek, today));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setDay(defaultDayIndex(weekStart, today));
    void (async () => {
      try {
        const [b, c, i, queue] = await Promise.all([
          getWeekBuckets(weekStart),
          getWeekCheckins(weekStart),
          getInjuries(),
          outbox.inspect().catch(() => []),
        ]);
        if (!live) return;
        setBuckets(b.data);
        setCheckins(mergeCheckins(c.data, pendingCheckins(queue, userId)));
        setInjuries(i.data);
      } catch (e) {
        if (live) reportError(e, "load check-ins");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [weekStart, today, userId]);

  const grid = useMemo(
    () => buildGrid(buckets, weekStart),
    [buckets, weekStart],
  );
  const counts = useMemo(
    () => dayCounts(checkins, weekStart, localDateOf),
    [checkins, weekStart],
  );
  const byEpisode = useMemo(
    () => new Map(injuries.map((e) => [e.episode_id, e])),
    [injuries],
  );
  const selectedDate = addDaysIso(weekStart, day);
  const dayRows = checkins.filter(
    (c) => localDateOf(c.recorded_at) === selectedDate,
  );

  return (
    <div className="checkin-week">
      <div className="checkin-week-nav">
        <button
          type="button"
          aria-label="Previous week"
          onClick={() => setWeekStart(addDaysIso(weekStart, -7))}
        >
          ‹
        </button>
        <span>
          {formatSessionDate(weekStart)} –{" "}
          {formatSessionDate(addDaysIso(weekStart, 6))}
        </span>
        <button
          type="button"
          aria-label="Next week"
          disabled={weekStart >= currentWeek}
          onClick={() => setWeekStart(addDaysIso(weekStart, 7))}
        >
          ›
        </button>
      </div>

      <table className="checkin-grid">
        {/* table-layout: fixed sizes columns from a <col>/<colgroup> width, or
            failing that from the FIRST row's cells — never from a later
            row's, per the fixed-table-layout algorithm. The label column's
            real width lives on tbody's `th[scope="row"]`, which is never the
            first row (thead's is), so a CSS width there alone is silently
            ignored and every column ends up equally divided. This colgroup
            is what actually makes --checkin-label-col control the rendered
            column, which is what .checkin-days below aligns to. */}
        <colgroup>
          <col />
          <col span={7} />
        </colgroup>
        <thead>
          <tr>
            <th />
            {DAY_NAMES.map((d, i) => (
              <th
                key={d}
                scope="col"
                className={i === day ? "is-selected" : undefined}
              >
                {d[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BUCKETS.map((b, bi) => (
            <tr key={b.value}>
              <th scope="row">{b.label}</th>
              {grid[bi].map((cell, di) => {
                const sel = di === day ? " is-selected" : "";
                const dayName = DAY_NAMES[di];
                if (cell.kind === "empty") {
                  return (
                    <td
                      key={di}
                      className={`is-empty${sel}`}
                      aria-label={`${b.label} ${dayName}: no check-ins`}
                    />
                  );
                }
                if (cell.kind === "noEnergy") {
                  return (
                    <td
                      key={di}
                      className={sel.trim() || undefined}
                      aria-label={`${b.label} ${dayName}: ${cell.n} check-in${cell.n === 1 ? "" : "s"}, no energy score`}
                    >
                      –<small>n{cell.n}</small>
                    </td>
                  );
                }
                return (
                  <td
                    key={di}
                    className={sel.trim() || undefined}
                    aria-label={`${b.label} ${dayName}: average energy ${cell.label} from ${cell.n} check-in${cell.n === 1 ? "" : "s"}`}
                    style={{
                      background: `color-mix(in srgb, var(--accent) ${cell.percent}%, transparent)`,
                    }}
                  >
                    {cell.label}
                    <small>n{cell.n}</small>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="checkin-days" role="group" aria-label="Day">
        {DAY_NAMES.map((d, i) => (
          <button
            key={d}
            type="button"
            aria-pressed={i === day}
            aria-label={`${d}, ${counts[i]} check-ins`}
            onClick={() => setDay(i)}
          >
            <b>{d}</b>
            <small>{counts[i]}</small>
          </button>
        ))}
      </div>

      <div className="checkin-day">
        <span className="field-label">{formatSessionDate(selectedDate)}</span>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : dayRows.length === 0 ? (
          <p className="muted">No check-ins.</p>
        ) : (
          dayRows.map((r) => {
            const ep = r.episode_id ? byEpisode.get(r.episode_id) : undefined;
            const bits = [
              ...r.tags.map(tagLabel),
              ep ? injuryLabel(ep) : null,
              r.training_impact
                ? `training: ${impactLabel(r.training_impact).toLowerCase()}`
                : null,
            ].filter(Boolean);
            return (
              <div className="checkin-entry" key={r.id}>
                <span className="checkin-entry-time">
                  {new Date(r.recorded_at).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                <span className="checkin-entry-energy">{r.energy ?? "–"}</span>
                <span>
                  {bits.length > 0 && (
                    <span className="checkin-entry-tags">
                      {bits.join(" · ")}
                    </span>
                  )}
                  {r.note && (
                    <span className="checkin-entry-note">{r.note}</span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
