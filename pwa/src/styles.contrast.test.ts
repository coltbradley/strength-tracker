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

function parseColor(tokens: Record<string, string>, token: string): Rgba {
  const v = resolve(tokens, `var(--${token})`).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`cannot parse --${token}: ${v}`);
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

// [foreground role, [background roles], minimum ratio, why]
const PAIRS: [string, string[], number, string][] = [
  ["text", SURFACES, 4.5, "body text"],
  ["text-dim", SURFACES, 4.5, "secondary text"],
  ["accent-dim", SURFACES, 4.5, "accent used as text"],
  ["danger", SURFACES, 4.5, "danger text / toast-error"],
  ["warn", SURFACES, 4.5, "warn text"],
  ["info", SURFACES, 4.5, "info text"],
  ["focus-set-current", SURFACES, 4.5, "current-set label"],
  ["text-inverse", ["accent", "accent-press", "danger", "text"], 4.5, "text on accent / danger / ink fills"],
  ["focus-set-completed-mark", ["focus-set-completed"], 4.5, "check on completed set"],
  ["control-border-color", SURFACES, 3, "control outlines (WCAG 1.4.11)"],
  ["focus-set-future", SURFACES, 3, "upcoming-set outline"],
  ["accent", SURFACES, 3, "accent UI (focus ring, fills)"],
];

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
