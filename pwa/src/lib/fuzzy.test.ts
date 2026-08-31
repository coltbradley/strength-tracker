import { describe, expect, it } from "vitest";
import { rank, score } from "./fuzzy";

const LIBRARY = [
  "Romanian Deadlift",
  "Barbell Deadlift",
  "Barbell Bench Press",
  "Barbell Bulgarian Split Squat",
  "Bench Press",
  "Leg Press",
  "Dumbbell Bicep Curl",
  "Crunch",
  "Barbell Squat",
  "Single-Arm Half-Kneeling Landmine Press (Deficit)",
  "Face Pull",
];
const top = (q: string, n = 1) => rank(LIBRARY, q, (x) => x).slice(0, n);

describe("the searches that plain substring matching fails", () => {
  it("initials find a two-word lift", () => {
    expect(top("rdl")).toEqual(["Romanian Deadlift"]);
  });

  it("words out of order, with a word between them", () => {
    expect(top("bulg split")).toEqual(["Barbell Bulgarian Split Squat"]);
  });

  it("one typo", () => {
    expect(top("bech press", 2)).toContain("Bench Press");
  });

  it("a partial second word narrows rather than breaks", () => {
    expect(top("barbell squ")).toEqual(["Barbell Squat"]);
  });

  it("finds a lift buried in a long parenthesised name", () => {
    expect(top("landmine")).toEqual([
      "Single-Arm Half-Kneeling Landmine Press (Deficit)",
    ]);
  });

  it("hyphenated names are searchable by either part", () => {
    expect(top("kneeling")).toEqual([
      "Single-Arm Half-Kneeling Landmine Press (Deficit)",
    ]);
  });
});

describe("ranking", () => {
  it("an exact name beats a longer one containing it", () => {
    expect(top("bench press")).toEqual(["Bench Press"]);
  });

  it("a word-start beats a mid-string hit", () => {
    // "Press" starts a word in both, but the shorter name wins the tier.
    expect(top("press")).toEqual(["Leg Press"]);
  });

  it("an empty query keeps the original order untouched", () => {
    expect(rank(LIBRARY, "  ", (x) => x)).toEqual(LIBRARY);
  });
});

describe("what must NOT match", () => {
  it("does not match an unrelated word with shared letters", () => {
    expect(score("Crunch", "curl")).toBe(0);
  });

  it("two typos is not a match", () => {
    expect(score("Bench Press", "bnech pres")).toBeGreaterThanOrEqual(0);
    expect(score("Face Pull", "bench")).toBe(0);
  });

  it("a query with no hits returns nothing rather than everything", () => {
    expect(rank(LIBRARY, "kettlebell swing", (x) => x)).toEqual([]);
  });
});

describe("a query with no word characters", () => {
  // words() keeps only [a-z0-9], so these tokenize to nothing. [].every() is
  // true, which used to hand a positive score to the entire library and hide
  // the "add a new exercise" prompt behind 873 irrelevant results.
  it.each(["深蹲", "🔥", "???", "---", "!!"])("%s matches nothing", (q) => {
    expect(score("Barbell Squat", q)).toBe(0);
    expect(score("Bench Press", q)).toBe(0);
  });

  it("still finds a custom exercise actually named in that script", () => {
    // the literal comparisons run before the word-based ones
    expect(score("深蹲", "深蹲")).toBeGreaterThan(0);
    expect(score("Squat 深蹲", "深蹲")).toBeGreaterThan(0);
  });

  it("an empty query still matches everything, as the picker expects", () => {
    expect(score("Barbell Squat", "")).toBeGreaterThan(0);
    expect(score("Barbell Squat", "   ")).toBeGreaterThan(0);
  });
});
