// Hand-rolled SVG bar chart: working sets per ISO week.

import { formatShortDate } from "../../lib/format";
import type { WeeklyVolumeRow } from "../../lib/types";

interface VolumeChartProps {
  weeks: WeeklyVolumeRow[];
}

const W = 360;
const H = 140;
const PAD = { top: 10, right: 10, bottom: 22, left: 28 };

export function VolumeChart({ weeks }: VolumeChartProps) {
  if (weeks.length === 0) {
    return <div className="chart-empty">No volume data yet</div>;
  }

  const shown = weeks.slice(-16); // last 16 weeks max
  const maxSets = Math.max(...shown.map((w) => w.working_sets), 1);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / shown.length;
  const barW = Math.min(slot * 0.7, 26);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label="weekly working sets"
    >
      {[maxSets, Math.round(maxSets / 2)].map((v) => {
        const y = PAD.top + (1 - v / maxSets) * innerH;
        return (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y}
              y2={y}
              className="chart-grid"
            />
            <text
              x={PAD.left - 6}
              y={y + 4}
              className="chart-tick"
              textAnchor="end"
            >
              {v}
            </text>
          </g>
        );
      })}
      {shown.map((w, i) => {
        const h = (w.working_sets / maxSets) * innerH;
        const x = PAD.left + i * slot + (slot - barW) / 2;
        return (
          <rect
            key={w.week_start}
            x={x}
            y={PAD.top + innerH - h}
            width={barW}
            height={h}
            rx={2}
            className="chart-bar"
          />
        );
      })}
      <text x={PAD.left} y={H - 6} className="chart-tick">
        {formatShortDate(shown[0].week_start)}
      </text>
      <text x={W - PAD.right} y={H - 6} className="chart-tick" textAnchor="end">
        {formatShortDate(shown[shown.length - 1].week_start)}
      </text>
    </svg>
  );
}
