// The legibility floors the Version D screens are held to: nothing set below
// 11px, and every control target at least 44px. Colour and size only come in
// through tokens, so the checks read the token block and the declarations.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const token = (name: string): number => {
  const match = styles.match(new RegExp(`${name}\\s*:\\s*([0-9.]+)px`));
  if (!match) throw new Error(`token ${name} not found`);
  return Number(match[1]);
};

describe("size floors", () => {
  it("keeps the smallest type tokens at 11px or more", () => {
    expect(token("--fs-micro")).toBeGreaterThanOrEqual(11);
    expect(token("--fs-label")).toBeGreaterThanOrEqual(11);
    expect(token("--fs-meta")).toBeGreaterThanOrEqual(11);
  });

  it("has no literal font-size below 11px", () => {
    const literals = [...styles.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
    expect(literals.filter((px) => px < 11)).toEqual([]);
  });

  it("keeps the minimum tap target at 44px", () => {
    expect(token("--tap-min")).toBeGreaterThanOrEqual(44);
    expect(token("--tap")).toBeGreaterThanOrEqual(44);
  });

  // The header's Focus | List segments rendered 40px tall while the token
  // check above passed: the floor has to be read off the rules that size the
  // controls, not only off the token.
  const minHeightOf = (selector: string): number => {
    const start = styles.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`rule ${selector} not found`);
    const body = styles.slice(start, styles.indexOf("}", start));
    const match = body.match(/min-height:\s*([^;]+);/);
    if (!match) throw new Error(`${selector} has no min-height`);
    const value = match[1]!.trim();
    if (value === "var(--tap-min)") return token("--tap-min");
    if (value === "var(--tap)") return token("--tap");
    const px = value.match(/^([0-9.]+)px$/);
    if (!px) throw new Error(`${selector}: cannot read min-height ${value}`);
    return Number(px[1]);
  };

  it.each([
    ".session-hd-seg",
    ".session-hd-count",
    ".sync-chip",
    ".gear-btn",
    ".focus-deck-more",
    ".text-link",
  ])("sizes %s to at least 44px", (selector) => {
    expect(minHeightOf(selector)).toBeGreaterThanOrEqual(44);
  });
});
