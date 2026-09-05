// @vitest-environment jsdom
// An expired code used to have exactly one way out: "Use a different email",
// which people then used to re-type the SAME address. Resend re-requests the
// code for the address already on screen, and the cooldown is what keeps that
// button from turning Supabase's per-address rate limit into a screenful of
// errors and no email. The countdown is derived from two timestamps rather
// than counted down, so this is the whole of its arithmetic.

import { describe, expect, it } from "vitest";
import { cooldownSeconds } from "./Login";

describe("cooldownSeconds", () => {
  it("is zero before anything has been sent", () => {
    expect(cooldownSeconds(0, 1_700_000_000_000)).toBe(0);
  });

  it("counts whole seconds down to the deadline", () => {
    const now = 1_700_000_000_000;
    expect(cooldownSeconds(now + 30_000, now)).toBe(30);
    expect(cooldownSeconds(now + 29_500, now)).toBe(30);
    expect(cooldownSeconds(now + 1_000, now)).toBe(1);
  });

  it("never reads 0s while the button is still disabled", () => {
    // The label and the `disabled` attribute are driven by the same number, so
    // any remaining time at all must round UP: "Resend in 0s" on a dead button
    // is the app lying about itself.
    const now = 1_700_000_000_000;
    expect(cooldownSeconds(now + 1, now)).toBe(1);
    expect(cooldownSeconds(now + 999, now)).toBe(1);
  });

  it("is zero at the deadline and after it", () => {
    const now = 1_700_000_000_000;
    expect(cooldownSeconds(now, now)).toBe(0);
    expect(cooldownSeconds(now - 60_000, now)).toBe(0);
  });
});
