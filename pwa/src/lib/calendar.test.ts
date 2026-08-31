import { describe, expect, it } from "vitest";
import {
  addDays,
  monthGrid,
  startOfWeek,
  weekDates,
  weekdayLetters,
} from "./calendar";

describe("addDays", () => {
  it("crosses a month boundary", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
  });

  it("crosses a year boundary", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("survives a DST spring-forward without losing a day", () => {
    // US DST began 2026-03-08. Naive 24h arithmetic skips or repeats a day
    // here; local Y/M/D construction does not.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
  });
});

describe("startOfWeek", () => {
  // 2026-08-31 is a Monday.
  it("Monday start", () => {
    expect(startOfWeek("2026-08-31", 1)).toBe("2026-08-31");
    expect(startOfWeek("2026-09-06", 1)).toBe("2026-08-31"); // that Sunday
  });

  it("Sunday start", () => {
    expect(startOfWeek("2026-08-31", 0)).toBe("2026-08-30");
    expect(startOfWeek("2026-08-30", 0)).toBe("2026-08-30");
  });

  it("Saturday start", () => {
    expect(startOfWeek("2026-08-31", 6)).toBe("2026-08-29");
    expect(startOfWeek("2026-08-29", 6)).toBe("2026-08-29");
  });

  it("is idempotent for every start day", () => {
    for (let ws = 0; ws < 7; ws++) {
      const a = startOfWeek("2026-08-31", ws);
      expect(startOfWeek(a, ws)).toBe(a);
    }
  });
});

describe("weekDates", () => {
  it("returns seven consecutive days beginning at the configured start", () => {
    const d = weekDates("2026-09-02", 1);
    expect(d).toHaveLength(7);
    expect(d[0]).toBe("2026-08-31");
    expect(d[6]).toBe("2026-09-06");
  });

  it("shifts the whole window when the start changes", () => {
    expect(weekDates("2026-09-02", 0)[0]).toBe("2026-08-30");
    expect(weekDates("2026-09-02", 6)[0]).toBe("2026-08-29");
  });
});

describe("monthGrid", () => {
  it("pads to whole weeks and marks the padding", () => {
    // August 2026 starts on a Saturday.
    const rows = monthGrid(2026, 7, 1);
    expect(rows.every((r) => r.length === 7)).toBe(true);
    expect(rows[0]![0]!.inMonth).toBe(false); // Mon 27 July
    expect(rows.flat().filter((c) => c.inMonth)).toHaveLength(31);
  });

  it("covers every day of the month exactly once", () => {
    for (const [y, m, len] of [
      [2026, 1, 28],
      [2028, 1, 29],
      [2026, 3, 30],
      [2026, 7, 31],
    ] as const) {
      const inMonth = monthGrid(y, m, 1)
        .flat()
        .filter((c) => c.inMonth)
        .map((c) => c.iso);
      expect(new Set(inMonth).size).toBe(len);
    }
  });

  it("does not emit a trailing week that belongs entirely to the next month", () => {
    for (let m = 0; m < 12; m++) {
      for (const ws of [0, 1, 6]) {
        const rows = monthGrid(2026, m, ws);
        expect(rows[rows.length - 1]!.some((c) => c.inMonth)).toBe(true);
        expect(rows[0]!.some((c) => c.inMonth)).toBe(true);
      }
    }
  });

  it("rows are contiguous: each starts the day after the last one ends", () => {
    const rows = monthGrid(2026, 7, 1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]![0]!.iso).toBe(addDays(rows[i - 1]![6]!.iso, 1));
    }
  });
});

describe("weekdayLetters", () => {
  it("starts on the configured day", () => {
    expect(weekdayLetters(1)[0]).toBe("M");
    expect(weekdayLetters(0)[0]).toBe("S"); // Sunday
    expect(weekdayLetters(6)[0]).toBe("S"); // Saturday
  });

  it("always returns seven", () => {
    for (let ws = 0; ws < 7; ws++) expect(weekdayLetters(ws)).toHaveLength(7);
  });
});
