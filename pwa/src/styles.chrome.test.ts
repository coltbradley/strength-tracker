// App-chrome fixes (final). Read off the stylesheet, like the other style
// tests: a header that reflows when the sync chip grows is a layout bug no
// component test can see.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const BLOCK = "/* ---- chrome fixes (final) ---- */";
const DECK = "/* ---- session focus deck";

describe("chrome fixes block", () => {
  it("sits right before the session focus deck", () => {
    const at = styles.indexOf(BLOCK);
    expect(at).toBeGreaterThan(0);
    expect(styles.indexOf(DECK)).toBeGreaterThan(at);
    expect(styles.indexOf(BLOCK, at + 1)).toBe(-1);
  });

  const block = () => styles.slice(styles.indexOf(BLOCK), styles.indexOf(DECK));

  it("D2: fixes the session sync chip to one 44px width above 360px", () => {
    const b = block();
    expect(b).toMatch(/@media \(min-width: 361px\)/);
    expect(b).toMatch(/\.topbar:has\(\.topbar-session\) \.sync-chip \{[^}]*width: var\(--tap-min\)/);
    expect(b).toMatch(/content: attr\(data-count\)/);
  });

  it("D2: the Report queue badge (9px) is gone from the stylesheet", () => {
    expect(styles).not.toContain(".fab-queue");
    expect(styles).not.toMatch(/font-size:[^;]*\b9px/);
  });
});
