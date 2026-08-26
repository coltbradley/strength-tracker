// Plate math. Pure, kg-in kg-out; display conversion happens at the edge.
//
// split() builds a per-side plate stack for a target load: greedy from the
// heaviest plate, plates loaded in pairs (the inventory lists one side's
// plates), remainder rounded DOWN — the gym answer to "what do I put on".

export interface PlateCount {
  /** plate weight in kg (one plate; it goes on both sides) */
  plate: number;
  /** count per side */
  count: number;
}

export interface PlateSplit {
  plates: PlateCount[];
  /** total plate weight per side, kg */
  perSideKg: number;
  /** achievedKg equals targetKg (within tolerance) */
  exact: boolean;
  /** bar + both sides actually loaded, kg */
  achievedKg: number;
}

// Inventory values may be exact-kg lb equivalents (45 lb = 20.41185665 kg),
// so all comparisons carry a small tolerance.
const EPS = 1e-6;

export function split(
  targetKg: number,
  barKg: number,
  inventoryKg: number[],
): PlateSplit {
  const inv = [...inventoryKg].filter((p) => p > 0).sort((a, b) => b - a);
  const wantedPerSide = (targetKg - barKg) / 2;

  const plates: PlateCount[] = [];
  let perSideKg = 0;

  if (wantedPerSide > EPS) {
    let remaining = wantedPerSide;
    for (const p of inv) {
      let count = 0;
      while (remaining >= p - EPS) {
        remaining -= p;
        count++;
      }
      if (count > 0) {
        plates.push({ plate: p, count });
        perSideKg += p * count;
      }
    }
  }

  const achievedKg = barKg + perSideKg * 2;
  return {
    plates,
    perSideKg,
    exact: Math.abs(achievedKg - targetKg) < 0.01,
    achievedKg,
  };
}
