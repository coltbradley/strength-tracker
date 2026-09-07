/* The single most useful thing a strength app can show and almost none do:
   WHAT TO PUT ON THE BAR. "112.5 kg" is a number you must then do arithmetic
   on, chalk on hands, mid-warmup. The plates are the actual instruction. */
export const BAR_KG = 20;
export const PLATES = [
  { kg: 25,   cls: "p25"  }, { kg: 20,   cls: "p20"  },
  { kg: 15,   cls: "p15"  }, { kg: 10,   cls: "p10"  },
  { kg: 5,    cls: "p5"   }, { kg: 2.5,  cls: "p2h"  },
  { kg: 1.25, cls: "p1h"  },
];
/** Greedy per side. Returns [] when the load is the bar alone or unloadable. */
export function perSide(totalKg, barKg = BAR_KG) {
  let side = (totalKg - barKg) / 2;
  if (side <= 0) return [];
  const out = [];
  for (const p of PLATES) {
    while (side >= p.kg - 1e-9) { out.push(p); side -= p.kg; }
  }
  return out;
}
