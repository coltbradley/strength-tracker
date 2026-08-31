// A month at a time, for planning past the end of this week.
//
// Today's strip shows seven days and nothing else, so a block written three
// weeks out was invisible from the app: you could only reach a day by being in
// its week. This is the way out — pick any date, land on it, close.
//
// It reads and does not write. Tapping a day selects it on Today; creating and
// editing still happen there and in the plan editor, so this stays a navigator
// rather than a third place that can change a plan.
import { useState } from "react";
import { Sheet } from "./Sheet";
import {
  monthGrid,
  monthLabel,
  weekdayLetters,
  type WeekStart,
} from "../lib/calendar";
import { parseLocalDate } from "../lib/format";

export interface CalendarDay {
  /** a workout is scheduled that day */
  planned: boolean;
  /** that workout is finished */
  done: boolean;
  /** that workout was skipped */
  skipped: boolean;
}

interface CalendarSheetProps {
  /** ISO day the calendar opens on, and the one drawn as selected */
  selected: string;
  today: string;
  weekStart: WeekStart;
  /** ISO day -> what is on it. Missing means a rest day. */
  days: Map<string, CalendarDay>;
  onPick: (iso: string) => void;
  onClose: () => void;
}

export function CalendarSheet({
  selected,
  today,
  weekStart,
  days,
  onPick,
  onClose,
}: CalendarSheetProps) {
  const anchor = parseLocalDate(selected);
  const [year, setYear] = useState(anchor.getFullYear());
  const [month, setMonth] = useState(anchor.getMonth());

  const step = (n: number) => {
    const d = new Date(year, month + n, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  const rows = monthGrid(year, month, weekStart);

  return (
    <Sheet title="Pick a day" onClose={onClose} tall>
      <div className="cal-head">
        <button
          type="button"
          className="cal-nav"
          aria-label="previous month"
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <span className="cal-month" aria-live="polite">
          {monthLabel(year, month)}
        </span>
        <button
          type="button"
          className="cal-nav"
          aria-label="next month"
          onClick={() => step(1)}
        >
          ›
        </button>
      </div>

      {/* aria-hidden: the letters are a visual ruler. Each day button already
          carries its own full spoken date, so announcing "M T W..." first is
          noise a screen reader has to sit through before every grid. */}
      <div className="cal-week-head" aria-hidden="true">
        {weekdayLetters(weekStart).map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>

      <div className="cal-grid" role="grid" aria-label={monthLabel(year, month)}>
        {rows.map((row, ri) => (
          <div className="cal-row" role="row" key={ri}>
            {row.map((cell) => {
              const d = days.get(cell.iso);
              const isToday = cell.iso === today;
              const isSelected = cell.iso === selected;
              const state = d?.done
                ? "done"
                : d?.skipped
                  ? "skipped"
                  : d?.planned
                    ? "planned"
                    : "rest";
              return (
                <button
                  key={cell.iso}
                  type="button"
                  role="gridcell"
                  aria-current={isSelected ? "date" : undefined}
                  aria-label={`${parseLocalDate(cell.iso).toLocaleDateString(
                    "en-GB",
                    { weekday: "long", day: "numeric", month: "long" },
                  )}${
                    state === "rest"
                      ? ", rest day"
                      : state === "done"
                        ? ", workout done"
                        : state === "skipped"
                          ? ", workout skipped"
                          : ", workout planned"
                  }`}
                  className={[
                    "cal-cell",
                    cell.inMonth ? "" : "cal-cell-out",
                    isToday ? "cal-cell-today" : "",
                    isSelected ? "cal-cell-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => onPick(cell.iso)}
                >
                  <span className="cal-cell-n">
                    {parseLocalDate(cell.iso).getDate()}
                  </span>
                  {/* One mark per state, never two. A day is done, skipped,
                      planned or empty — the strip on Today says the same. */}
                  <span className={`cal-dot cal-dot-${state}`} />
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="cal-key">
        <span>
          <span className="cal-dot cal-dot-planned" /> planned
        </span>
        <span>
          <span className="cal-dot cal-dot-done" /> done
        </span>
        <span>
          <span className="cal-dot cal-dot-skipped" /> skipped
        </span>
      </div>
    </Sheet>
  );
}
