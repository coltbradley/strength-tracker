// Hand-rolled SVG line chart: best e1RM per session, optional goal line.

import { toDisplay } from "../../lib/units";
import { useUnit } from "../../hooks/useUnit";
import type { SessionBestE1rmRow } from "../../lib/types";

interface E1rmChartProps {
  series: SessionBestE1rmRow[];
  goalKg: number | null;
}

const W = 360;
const H = 180;
const PAD = { top: 12, right: 10, bottom: 22, left: 40 };

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
      ? (PAD.left + W - PAD.right) / 2
      : PAD.left + ((t - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);
  const py = (v: number) =>
    yMax === yMin
      ? H / 2
      : PAD.top + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const path = series
    .map(
      (s, i) =>
        `${i === 0 ? "M" : "L"}${px(new Date(s.performed_at).getTime()).toFixed(1)},${py(s.best_e1rm_kg).toFixed(1)}`,
    )
    .join(" ");

  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  const first = new Date(xMin);
  const last = new Date(xMax);
  const fmtDate = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label="e1RM trend"
    >
      {yTicks.map((v) => (
        <g key={v}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={py(v)}
            y2={py(v)}
            className="chart-grid"
          />
          <text
            x={PAD.left - 6}
            y={py(v) + 4}
            className="chart-tick"
            textAnchor="end"
          >
            {Math.round(toDisplay(v, unit))}
          </text>
        </g>
      ))}
      {goalKg !== null && (
        <g>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={py(goalKg)}
            y2={py(goalKg)}
            className="chart-goal"
          />
          <text
            x={W - PAD.right}
            y={py(goalKg) - 4}
            className="chart-goal-label"
            textAnchor="end"
          >
            goal {toDisplay(goalKg, unit)} {unit}
          </text>
        </g>
      )}
      <path d={path} className="chart-line" fill="none" />
      {series.map((s) => (
        <circle
          key={s.session_id}
          cx={px(new Date(s.performed_at).getTime())}
          cy={py(s.best_e1rm_kg)}
          r={3}
          className="chart-dot"
        />
      ))}
      <text x={PAD.left} y={H - 6} className="chart-tick">
        {fmtDate(first)}
      </text>
      <text x={W - PAD.right} y={H - 6} className="chart-tick" textAnchor="end">
        {fmtDate(last)}
      </text>
    </svg>
  );
}
