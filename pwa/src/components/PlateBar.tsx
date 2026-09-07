// The loaded bar, drawn, under the load field.
//
// The plate breakdown already existed as a `.plate-hint` button in the section
// head: correct, and 10.5px, and a tap away from the diagram. A design review
// of six equipment states put it plainly — this line is "the answer to the
// question the screen exists to ask", and it was set in the smallest type on
// the screen.
//
// So this is the same arithmetic, promoted. Nothing here computes anything:
// `split()` in lib/plates.ts is the authority and is better than any of the
// prototypes written against it (inventory-aware, reports whether the target
// is achievable, bounded against a hang). This only draws what it returns.
//
// Why a picture and not just bigger text: at arm's length you read the
// SILHOUETTE of the load before you read digits, and the silhouette is exactly
// what you are about to check against the bar in front of you. Plate colours
// are the competition colours, so they are INFORMATION — the reason the plates
// carry colour and nothing else on this screen does.
//
// Loading order is heaviest-inboard, against the sleeve shoulder, which is how
// a bar is actually loaded. An earlier draft had it backwards; a lifter catches
// that in half a second and stops trusting the whole feature.

import type { PlateSplit } from "../lib/plates";
import { formatPlate } from "../lib/format";
import type { Unit } from "../lib/units";

interface PlateBarProps {
  split: PlateSplit;
  /** 0 when the movement has no bar (a machine); the shaft is then omitted */
  barKg: number;
  unit: Unit;
}

/** Rendered width in px for one plate, by kg. Ordered heaviest first so the
 *  stack reads big-to-small outward, and so a 1.25 never draws wider than a
 *  20. Anything unlisted (an lb-equivalent inventory) falls to the smallest. */
function plateClass(kg: number): string {
  if (kg >= 25) return "pb-25";
  if (kg >= 20) return "pb-20";
  if (kg >= 15) return "pb-15";
  if (kg >= 10) return "pb-10";
  if (kg >= 5) return "pb-5";
  if (kg >= 2.5) return "pb-2h";
  return "pb-1h";
}

export function PlateBar({ split, barKg, unit }: PlateBarProps) {
  // Heaviest first = innermost, against the collar.
  const side = split.plates.flatMap((p) =>
    Array.from({ length: p.count }, () => p.plate),
  );
  if (side.length === 0) return null;

  const stack = (reversed: boolean) => {
    const order = reversed ? [...side].reverse() : side;
    return order.map((kg, i) => (
      <i key={i} className={`pb-plate ${plateClass(kg)}`} />
    ));
  };

  const text = split.plates
    .map(
      (p) => `${p.count > 1 ? `${p.count}×` : ""}${formatPlate(p.plate, unit)}`,
    )
    .join(" + ");

  return (
    <div className="plate-bar-wrap">
      <div className="plate-bar" aria-hidden="true">
        {barKg > 0 && <span className="pb-shaft" />}
        <span className="pb-stack">
          <i className="pb-collar" />
          {stack(true)}
        </span>
        <span className="pb-stack">
          {stack(false)}
          <i className="pb-collar" />
        </span>
      </div>
      {/* the words carry it for a screen reader and for anyone who cannot
          tell the colours apart; the diagram is decoration without them */}
      <div className="plate-bar-key">
        {text} per side
        {!split.exact && (
          <span className="plate-bar-warn">
            {" "}
            · closest is {formatPlate(split.achievedKg, unit)}
          </span>
        )}
      </div>
    </div>
  );
}
