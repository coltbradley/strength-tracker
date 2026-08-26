// Hand-rolled bar chart: working sets per ISO week, most recent bar in
// orange, hairline baseline.

import { formatShortDate } from "../../lib/format";
import type { WeeklyVolumeRow } from "../../lib/types";

interface VolumeChartProps {
  weeks: WeeklyVolumeRow[];
}

const W = 340;
const H = 80;

export function VolumeChart({ weeks }: VolumeChartProps) {
  if (weeks.length === 0) {
    return <div className="chart-empty">No volume data yet</div>;
  }

  const shown = weeks.slice(-16); // last 16 weeks max
  const maxSets = Math.max(...shown.map((w) => w.working_sets), 1);
  const slot = W / shown.length;
  const barW = Math.min(slot * 0.72, 30);

  return (
    <div>
      <div className="chart-baseline">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="chart chart-volume"
          role="img"
          aria-label="weekly working sets"
        >
          {shown.map((w, i) => {
            const h = Math.max(2, (w.working_sets / maxSets) * H);
            const x = i * slot + (slot - barW) / 2;
            return (
              <rect
                key={w.week_start}
                x={x}
                y={H - h}
                width={barW}
                height={h}
                className={
                  i === shown.length - 1
                    ? "chart-bar chart-bar-last"
                    : "chart-bar"
                }
              />
            );
          })}
        </svg>
      </div>
      <div className="chart-ticks">
        <span>{formatShortDate(shown[0].week_start)}</span>
        <span>{formatShortDate(shown[shown.length - 1].week_start)}</span>
      </div>
    </div>
  );
}
