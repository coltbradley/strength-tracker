// @vitest-environment jsdom
//
// The bug this hook exists for cannot be reproduced by a page load, which is
// why it survived so long: it needs an app that is ALREADY MOUNTED when the
// day changes underneath it. Fake timers are the only way to state that in a
// test — mount the hook at 23:59, move the world past midnight, and check the
// hook noticed. The second case is the one iOS actually produces: the app was
// suspended, so the timer never fired at all, and the only signal is the app
// coming back to the foreground.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useLocalToday } from "./useLocalToday";

/** 2026-09-04 23:59:00 LOCAL — constructed from parts, never parsed from a
 *  string, so the expected ISO days below hold in every timezone the suite
 *  might run in. */
const LATE_MONDAY = new Date(2026, 8, 4, 23, 59, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(LATE_MONDAY);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useLocalToday", () => {
  it("rolls over when local midnight passes with the app still mounted", () => {
    const { result } = renderHook(() => useLocalToday());
    expect(result.current).toBe("2026-09-04");

    // Half a minute later it is still the same day, and nothing has fired.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe("2026-09-04");

    // Past midnight: the armed timer fires and the day moves.
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(result.current).toBe("2026-09-05");

    // And it re-armed itself for the following midnight rather than firing
    // once and going quiet.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("notices a day change on visibilitychange, with no timer having fired", () => {
    const { result } = renderHook(() => useLocalToday());
    expect(result.current).toBe("2026-09-04");

    // The iOS case: the app was suspended overnight, so the clock moved but
    // the timer never ran. Only the return to the foreground can tell us.
    act(() => {
      vi.setSystemTime(new Date(2026, 8, 5, 6, 0, 0, 0));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe("2026-09-05");
  });

  it("also re-reads the day on the online event", () => {
    const { result } = renderHook(() => useLocalToday());

    act(() => {
      vi.setSystemTime(new Date(2026, 8, 5, 6, 0, 0, 0));
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe("2026-09-05");
  });

  it("removes both listeners and its timer on unmount", () => {
    const docRemove = vi.spyOn(document, "removeEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useLocalToday());
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(docRemove).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(winRemove).toHaveBeenCalledWith("online", expect.any(Function));
    // The midnight timer is gone too: a stray one would call setState on an
    // unmounted hook every night for as long as the tab lived.
    expect(vi.getTimerCount()).toBe(0);

    docRemove.mockRestore();
    winRemove.mockRestore();
  });
});
