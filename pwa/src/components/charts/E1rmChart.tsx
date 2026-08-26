// Hand-rolled SVG line chart: best e1RM per session. Ink polyline, dashed
// teal goal line, orange dot on the latest point, hairline left/bottom frame,
// month tick labels underneath.

import { useUnit } from "../../hooks/useUnit";
import { formatMonth, formatShortDate } from "../../lib/format";
import { toDisplay } from "../../lib/units";
import type { SessionBestE1rmRow } from "../../lib/types";

interface E1rmChartProps {
  series: SessionBestE1rmRow[];
  goalKg: number | null;
}

const W = 340;
const H = 150;
const PAD = { top: 14, right: 8, bottom: 8, left: 4 };

export function E1rmChart({ series, goalKg }: E1rmChartProps) {
  const unit = useUnit();

  if (series.length === 0) {
    return <div className="chart-empty">No e1RM data yet</div>;
  }

  const xs = series.map((s) => new Date(s.performed_at).getTime());
  const ys = series.map((s) => s.best_e1rm_kg);
  const allY = goalKg !== null ? [...ys, goalKg] : ys;

  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...allY) * 0.95;
  const yMax = Math.max(...allY) * 1.05;

  const px = (t: number) =>
    xMax === xMin
      ? W / 2
      : PAD.left + ((t - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);
  const py = (v: number) =>
    yMax === yMin
      ? H / 2
      : PAD.top + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const points = series
    .map(
      (s) =>
        `${px(new Date(s.performed_at).getTime()).toFixed(1)},${py(s.best_e1rm_kg).toFixed(1)}`,
    )
    .join(" ");

  const last = series[series.length - 1];

  // month labels across the range; fall back to short dates within one month
  const months: string[] = [];
  for (const t of xs) {
    const m = formatMonth(new Date(t));
    if (months[months.length - 1] !== m) months.push(m);
  }
  const ticks =
    months.length > 1
      ? months
      : [formatShortDate(new Date(xMin)), formatShortDate(new Date(xMax))];

  return (
    <div>
      <div className="chart-frame">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="chart"
          role="img"
          aria-label={`e1RM trend, latest ${toDisplay(last.best_e1rm_kg, unit)} ${unit}`}
        >
          {goalKg !== null && (
            <line
              x1={0}
              x2={W}
              y1={py(goalKg)}
              y2={py(goalKg)}
              className="chart-goal"
            />
          )}
          <polyline points={points} className="chart-line" fill="none" />
          <circle
            cx={px(new Date(last.performed_at).getTime())}
            cy={py(last.best_e1rm_kg)}
            r={4}
            className="chart-dot"
          />
        </svg>
      </div>
      <div className="chart-ticks">
        {ticks.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </div>
  );
}
