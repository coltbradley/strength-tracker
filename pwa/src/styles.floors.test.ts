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
});
