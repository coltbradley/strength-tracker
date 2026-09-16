import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("./styles.css", import.meta.url),
  "utf8",
);

function ruleBody(source: string, selector: string): string {
  const marker = `${selector} {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing CSS selector ${selector}`);
  const bodyStart = start + marker.length;
  const end = source.indexOf("}", bodyStart);
  if (end < 0) throw new Error(`Unclosed CSS selector ${selector}`);
  return source.slice(bodyStart, end);
}

describe("topbar cluster reads as one subordinate group, not two", () => {
  it("does not give the coach action full ink while Report and the gear stay dim", () => {
    // .header-action already sets color: var(--text-dim) for every
    // action in the row, and .gear-btn sets the same. A leftover
    // .header-action-coach override singled the coach icon out in full
    // ink beside two dim ones — the header reading as two menus rather
    // than one quiet cluster (2026-09-16 spec, Header section).
    // The override is removed, so the selector should not have a color rule
    // that overrides the dim setting from .header-action.
    const marker = ".header-action-coach {";
    const hasRule = styles.indexOf(marker) >= 0;
    if (hasRule) {
      expect(ruleBody(styles, ".header-action-coach")).not.toContain(
        "color: var(--text)",
      );
    }
    // If the rule doesn't exist at all, that's also correct
  });

  it("still lets the header-action rule set every action to the same dim ink", () => {
    expect(ruleBody(styles, ".header-action")).toContain(
      "color: var(--text-dim)",
    );
  });
});
