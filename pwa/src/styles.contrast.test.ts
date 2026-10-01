// WCAG contrast for BOTH themes, computed from the tokens in styles.css — the
// single source of truth — so a palette edit that drops a pair below AA fails
// here instead of in someone's gym. Adding a theme-dependent colour? Add its
// pair to PAIRS below.
//
// Resolution: light = the `:root` block; dark = light overlaid with the
// `:root[data-theme="dark"]` block (exactly the cascade the browser applies).
// `var()` chains and `rgb(var(--ink-rgb) / a)` are resolved here, and
// translucent colours are composited over the surface they sit on.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function block(selector: string): string {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${selector}`);
  let depth = 1;
  let i = start + marker.length;
  const from = i;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
    i += 1;
  }
  return css.slice(from, i - 1);
}

function decls(body: string): Record<string, string> {
  return Object.fromEntries(
    [...body.matchAll(/^\s*--([\w-]+)\s*:\s*([^;]+);/gm)].map(([, n, v]) => [n, v.trim()]),
  );
}

const LIGHT = decls(block(":root"));
const DARK = { ...LIGHT, ...decls(block(':root[data-theme="dark"]')) };

type Rgba = [number, number, number, number];

function resolve(tokens: Record<string, string>, value: string, depth = 0): string {
  if (depth > 20) throw new Error(`var() cycle at ${value}`);
  return value.replace(/var\(--([\w-]+)\)/g, (_m, name: string) => {
    const v = tokens[name];
    if (v === undefined) throw new Error(`--${name} is undefined`);
    return resolve(tokens, v, depth + 1);
  });
}

function parseValue(v: string): Rgba {
  v = v.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  // color-mix(in srgb, <colour> <p>%, <colour>): the rest-strip surfaces
  m = /^color-mix\(\s*in srgb\s*,\s*(#[0-9a-f]{6}|rgb\([^)]*\))\s+([\d.]+)%\s*,\s*(#[0-9a-f]{6}|rgb\([^)]*\))\s*\)$/i.exec(v);
  if (m) {
    const [a, b, w] = [parseValue(m[1]), parseValue(m[3]), +m[2] / 100];
    return [0, 1, 2].map((i) => a[i] * w + b[i] * (1 - w)).concat(1) as Rgba;
  }
  throw new Error(`cannot parse colour: ${v}`);
}

function parseColor(tokens: Record<string, string>, token: string): Rgba {
  return parseValue(resolve(tokens, `var(--${token})`));
}

function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1) as Rgba;
}

function lum([r, g, b]: Rgba): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(tokens: Record<string, string>, fg: string, bg: string): number {
  const back = parseColor(tokens, bg);
  const front = over(parseColor(tokens, fg), back);
  const [a, b] = [lum(front), lum(back)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const SURFACES = ["bg", "bg-raised", "bg-input"];
// Version D focus-dock surfaces: the dock panel, a card or number sitting on
// it, the keys and chips on top, the pressed key, and the current-row tint.
// (surface-key-press is a momentary state and is left out of the secondary
// text and outline pairs: light --text-dim is 4.4:1 on it, a known shortfall.)
const DOCK = ["surface-dock", "surface-card", "surface-key", "surface-current"];
// the rest strip sits on its own tinted surfaces, not on a page surface
const REST = ["rest-surface", "rest-ready-surface"];

// [foreground role, [background roles], minimum ratio, why]
const PAIRS: [string, string[], number, string][] = [
  ["text", SURFACES, 4.5, "body text"],
  ["text-dim", SURFACES, 4.5, "secondary text"],
  ["accent-dim", SURFACES, 4.5, "accent used as text"],
  ["danger", SURFACES, 4.5, "danger text / toast-error"],
  ["warn", SURFACES, 4.5, "warn text"],
  ["info", SURFACES, 4.5, "info text"],
  ["focus-set-current", SURFACES, 4.5, "current-set label"],
  ["text", REST, 4.5, "rest strip: timer, labels"],
  ["text-dim", REST, 4.5, "rest strip: next-set line"],
  ["accent", REST, 4.5, "rest strip: RESTING / REST OVER label (accent as text)"],
  // selected chips / segments: .chip-on, .seg-on fill with --text and print
  // --bg on it; .chip-pain.chip-on fills with --danger
  ["bg", ["text", "danger"], 4.5, "label on a selected chip / segment"],
  ["text-inverse", ["accent", "accent-press", "danger", "text"], 4.5, "text on accent / danger / ink fills"],
  ["focus-set-completed-mark", ["focus-set-completed"], 4.5, "check on completed set"],
  ["control-border-color", SURFACES, 3, "control outlines (WCAG 1.4.11)"],
  ["focus-set-future", SURFACES, 3, "upcoming-set outline"],
  ["accent", SURFACES, 3, "accent UI (focus ring, fills)"],
  // Version D dock and current-row surfaces (and the receipts, state words and
  // load picture that sit on them)
  ["text", [...DOCK, "surface-key-press"], 4.5, "dock: load, reps, keys, row text"],
  ["text-dim", DOCK, 4.5, "dock: secondary text, receipts, state words"],
  ["state-skipped", DOCK, 4.5, "skipped state word"],
  ["accent-dim", ["surface-dock", "surface-card", "surface-current"], 4.5, "accent as text on dock cards (NOW, receipts)"],
  ["focus-set-current", ["surface-dock", "surface-card", "surface-current"], 4.5, "current-set label on dock and current row"],
  ["danger", ["surface-dock", "surface-card", "surface-current"], 4.5, "Needs review receipt, errors"],
  ["info", ["surface-dock", "surface-card", "surface-current"], 4.5, "On this phone receipt"],
  ["control-border-color", DOCK, 3, "dock: control outlines"],
  ["focus-set-future", DOCK, 3, "dock: upcoming-set outline"],
  ["text-on-accent", ["accent", "accent-press"], 4.5, "Log button and accent fills"],
  // the Version D skin on sheets: a danger wash behind Remove / the Failed
  // tile, and the sheet cards that sit on the raised sheet surface
  ["danger", ["surface-danger"], 4.5, "Remove, Failed count, armed void"],
  ["text", ["surface-danger"], 4.5, "text on a danger wash"],
  ["text-dim", ["surface-danger"], 4.5, "secondary text on a danger wash"],
  ["focus-set-completed-mark", ["focus-set-completed"], 4.5, "completed mark"],
];

// The load picture: every plate class and the steel read against the surface
// they are drawn on (graphical objects, WCAG 1.4.11). Dark only: the light
// palette is the approved design, and its yellow 15 plate is identified by its
// hairline edge and label rather than by contrast with white.
const PLATES = ["plate-25", "plate-20", "plate-15", "plate-10", "plate-5", "plate-2h", "lp-steel"];

const THEMES: [string, Record<string, string>][] = [
  ["light", LIGHT],
  ["dark", DARK],
];

describe.each(THEMES)("%s theme contrast", (_name, tokens) => {
  for (const [fg, bgs, min, why] of PAIRS) {
    for (const bg of bgs) {
      it(`${fg} on ${bg} >= ${min}:1 (${why})`, () => {
        expect(ratio(tokens, fg, bg)).toBeGreaterThanOrEqual(min);
      });
    }
  }
});

describe("dark theme load picture", () => {
  for (const plate of PLATES) {
    for (const surface of ["surface-dock", "surface-card", "bg"]) {
      it(`${plate} on ${surface} >= 3:1`, () => {
        expect(ratio(DARK, plate, surface)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

// The check-in grid tints --accent by up to MAX_ENERGY_FILL_PERCENT * --heat-scale
// over the page and puts --text on it (CheckinWeek.tsx, lib/checkinWeek.ts).
describe.each(THEMES)("%s theme check-in heat cell", (_name, tokens) => {
  it.each([10, 57])("--text stays AA on an accent fill of %i%%", (percent) => {
    const scale = Number(tokens["heat-scale"]);
    const fill = over(
      [...parseColor(tokens, "accent").slice(0, 3), (percent / 100) * scale] as Rgba,
      parseColor(tokens, "bg"),
    );
    const text = over(parseColor(tokens, "text"), fill);
    const [a, b] = [lum(text), lum(fill)].sort((x, y) => y - x);
    expect((a + 0.05) / (b + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});

// Placeholder text. Light keeps Chromium's long-standing #757575 so light mode
// stays pixel-identical; that is 4.4:1 on the input surface, a known shortfall
// (darken --placeholder in `:root` to #6f6f6f to reach AA when light may move).
describe("input placeholder contrast", () => {
  it("dark >= 4.5:1 on the input surface", () => {
    expect(ratio(DARK, "placeholder", "bg-input")).toBeGreaterThanOrEqual(4.5);
  });
  it("light does not regress below 4.4:1", () => {
    expect(ratio(LIGHT, "placeholder", "bg-input")).toBeGreaterThanOrEqual(4.4);
  });
});

// A colour added to `:root` without a dark value silently keeps its LIGHT
// value in dark. Every literal-colour token must be overridden in the dark
// block or be listed here with the reason it need not be.
describe("dark block coverage", () => {
  // alpha-only or theme-neutral by construction
  const THEME_NEUTRAL: Record<string, string> = {
    "mask-opaque": "alpha-only: a mask shows the layer where it is opaque",
  };
  it("overrides every literal colour token declared in :root", () => {
    const dark = decls(block(':root[data-theme="dark"]'));
    const missing = Object.entries(LIGHT)
      .filter(([, value]) => /^(#[0-9a-f]{3,8}|rgb\(\s*\d)/i.test(value))
      .map(([name]) => name)
      .filter((name) => !(name in dark) && !(name in THEME_NEUTRAL));
    expect(missing).toEqual([]);
  });
});
