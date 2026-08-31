// The week strip swipes now, so week arithmetic has become load-bearing on a
// screen where it used to be a single derived list. The two places it can be
// silently wrong are month ends and year ends — a +7 that stays in the wrong
// month, or a range label that renders "29–4 DEC" across New Year.

import { describe, expect, it } from "vitest";
import { weekPageDate, weekPages, weekRangeLabel } from "./Today";

describe("weekPageDate", () => {
  it("is the identity for the page already selected", () => {
    expect(weekPageDate("2026-08-30", 1)).toBe("2026-08-30");
  });

  it("steps a whole week either way", () => {
    expect(weekPageDate("2026-08-19", 0)).toBe("2026-08-12");
    expect(weekPageDate("2026-08-19", 2)).toBe("2026-08-26");
  });

  it("crosses a month end", () => {
    expect(weekPageDate("2026-09-02", 0)).toBe("2026-08-26");
    expect(weekPageDate("2026-08-26", 2)).toBe("2026-09-02");
  });

  it("crosses a year end", () => {
    expect(weekPageDate("2027-01-02", 0)).toBe("2026-12-26");
    expect(weekPageDate("2026-12-28", 2)).toBe("2027-01-04");
  });

  it("crosses a leap day", () => {
    expect(weekPageDate("2028-03-01", 0)).toBe("2028-02-23");
    expect(weekPageDate("2028-02-23", 2)).toBe("2028-03-01");
  });
});

describe("weekPages", () => {
  it("renders last week, the selected week and next week", () => {
    const [prev, current, next] = weekPages("2026-08-30", 1);
    expect(current[0]).toBe("2026-08-24");
    expect(current[6]).toBe("2026-08-30");
    expect(prev[0]).toBe("2026-08-17");
    expect(next[6]).toBe("2026-09-06");
  });

  it("honours the configured week start", () => {
    // 2026-08-30 is itself a Sunday: on a Sunday start it OPENS the week it
    // closes on a Monday start.
    expect(weekPages("2026-08-30", 0)[1][0]).toBe("2026-08-30");
    expect(weekPages("2026-08-30", 6)[1][0]).toBe("2026-08-29");
  });

  it("spans the year end without losing a day", () => {
    const [, current] = weekPages("2026-01-01", 1);
    expect(current).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });
});

describe("weekRangeLabel", () => {
  it("names one month once", () => {
    expect(weekRangeLabel(weekPages("2026-08-30", 1)[1])).toBe("24–30 AUG");
  });

  it("names both months across a month end", () => {
    expect(weekRangeLabel(weekPages("2026-09-02", 1)[1])).toBe(
      "31 AUG – 6 SEPT",
    );
  });

  it("names both months across a year end", () => {
    expect(weekRangeLabel(weekPages("2026-01-01", 1)[1])).toBe(
      "29 DEC – 4 JAN",
    );
  });
});
