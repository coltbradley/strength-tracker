// @vitest-environment jsdom
//
// The bug this hook exists for is not "the screen slept" — it is "the screen
// slept AGAIN, after the first time it worked". A wake lock is dropped by the
// browser on every hide and never comes back on its own, so a hook that only
// requests at mount looks correct for one set and then quietly stops. The
// re-acquire case below is the one that matters; the rest is making sure the
// hook never becomes a source of errors on a device that has no such API.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useWakeLock } from "./useWakeLock";

interface FakeSentinel {
  release: ReturnType<typeof vi.fn>;
}

/** Install a wake-lock double on navigator; returns the request spy. */
function installWakeLock(): {
  request: ReturnType<typeof vi.fn>;
  sentinels: FakeSentinel[];
} {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(() => {
    const s: FakeSentinel = { release: vi.fn(() => Promise.resolve()) };
    sentinels.push(s);
    return Promise.resolve(s);
  });
  Object.defineProperty(navigator, "wakeLock", {
    value: { request },
    configurable: true,
    writable: true,
  });
  return { request, sentinels };
}

function removeWakeLock(): void {
  Object.defineProperty(navigator, "wakeLock", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

/** jsdom has no page lifecycle; visibility is set by hand. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

/** Let the request promise settle inside act, so React sees the effect run. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  removeWakeLock();
  setVisibility("visible");
  vi.restoreAllMocks();
});

describe("useWakeLock", () => {
  it("requests a screen lock while enabled", async () => {
    setVisibility("visible");
    const { request } = installWakeLock();

    renderHook(() => useWakeLock(true));
    await settle();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
  });

  it("asks for nothing while disabled", async () => {
    setVisibility("visible");
    const { request } = installWakeLock();

    renderHook(() => useWakeLock(false));
    await settle();

    expect(request).not.toHaveBeenCalled();
  });

  it("releases on unmount", async () => {
    setVisibility("visible");
    const { sentinels } = installWakeLock();

    const { unmount } = renderHook(() => useWakeLock(true));
    await settle();
    expect(sentinels).toHaveLength(1);

    unmount();
    expect(sentinels[0].release).toHaveBeenCalled();
  });

  it("releases when `enabled` goes false, and re-requests when it returns", async () => {
    setVisibility("visible");
    const { request, sentinels } = installWakeLock();

    const { rerender } = renderHook(
      ({ on }: { on: boolean }) => useWakeLock(on),
      { initialProps: { on: true } },
    );
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    rerender({ on: false });
    expect(sentinels[0].release).toHaveBeenCalled();

    rerender({ on: true });
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("re-acquires after the page is hidden and shown again", async () => {
    setVisibility("visible");
    const { request, sentinels } = installWakeLock();

    renderHook(() => useWakeLock(true));
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    // Hidden: the browser drops the lock. Nothing is requested here — a
    // request made while hidden is rejected by spec.
    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sentinels[0].release).toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);

    // Visible again: this is the ask that a mount-only hook never makes.
    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops listening after unmount", async () => {
    setVisibility("visible");
    const { request } = installWakeLock();

    const { unmount } = renderHook(() => useWakeLock(true));
    await settle();
    unmount();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("is a silent no-op when the API is absent", async () => {
    setVisibility("visible");
    removeWakeLock();

    expect(() => {
      renderHook(() => useWakeLock(true));
    }).not.toThrow();
    await settle();

    // And the listener it never registered cannot misfire either.
    expect(() => {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }).not.toThrow();
  });

  it("swallows a rejected request", async () => {
    setVisibility("visible");
    const request = vi.fn(() => Promise.reject(new Error("battery saver")));
    Object.defineProperty(navigator, "wakeLock", {
      value: { request },
      configurable: true,
      writable: true,
    });

    const { unmount } = renderHook(() => useWakeLock(true));
    await settle();
    expect(request).toHaveBeenCalled();
    // Nothing was ever held, so unmount has nothing to release and must not
    // throw reaching for it.
    expect(() => unmount()).not.toThrow();
  });
});
