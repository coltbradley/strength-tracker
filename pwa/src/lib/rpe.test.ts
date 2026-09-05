// The scale is DERIVED from the column's bounds, not typed out, so the only
// way the app can offer a value Postgres refuses is if this arithmetic is
// wrong. Half points are exact in binary; a step that was not would put
// 7.499999 on a chip and a CHECK violation in the outbox.

import { describe, expect, it } from "vitest";
import {
  RPE_CHOICES,
  RPE_FLOOR_OFFERED,
  RPE_MAX,
  RPE_MIN,
  RPE_SCALE,
} from "./rpe";

describe("RPE_SCALE", () => {
  it("is every half point the column accepts, ends included", () => {
    expect(RPE_SCALE).toEqual([5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]);
    expect(RPE_SCALE[0]).toBe(RPE_MIN);
    expect(RPE_SCALE[RPE_SCALE.length - 1]).toBe(RPE_MAX);
  });

  it("holds exact values, so `rpe * 2 = trunc(rpe * 2)` still passes", () => {
    for (const v of RPE_SCALE) expect(v * 2).toBe(Math.trunc(v * 2));
  });
});

describe("RPE_CHOICES", () => {
  it("is what the chips offer: 6.5 up, and nothing the column would refuse", () => {
    expect(RPE_CHOICES).toEqual([6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]);
    expect(RPE_CHOICES.every((v) => RPE_SCALE.includes(v))).toBe(true);
  });

  it("floors above the column, never below it", () => {
    // The UI floor is an editorial call about what is worth a tap; the column
    // floor is what is legal. A row that arrives at 5 from anywhere else is
    // still valid and still renders — this only says what we ASK for.
    expect(RPE_FLOOR_OFFERED).toBeGreaterThan(RPE_MIN);
    expect(Math.min(...RPE_CHOICES)).toBe(RPE_FLOOR_OFFERED);
  });
});
