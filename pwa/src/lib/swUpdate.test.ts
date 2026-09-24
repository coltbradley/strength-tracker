import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateGate } from "./swUpdate";

class FakeDoc extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";
  setVisibility(v: "visible" | "hidden") {
    this.visibilityState = v;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("service worker update gate (A-04)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("applies at once when no session is open", async () => {
    const apply = vi.fn();
    const gate = createUpdateGate({
      sessionInProgress: async () => false,
      apply,
      doc: new FakeDoc(),
    });
    gate.onNeedRefresh();
    await settle();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("never applies while a session is open, even when the phone locks between sets", async () => {
    const apply = vi.fn();
    const doc = new FakeDoc();
    let open = true;
    const gate = createUpdateGate({
      sessionInProgress: async () => open,
      apply,
      doc,
    });
    gate.onNeedRefresh();
    await settle();
    doc.setVisibility("hidden");
    await settle();
    doc.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(apply).not.toHaveBeenCalled();

    // Finish: the pointer is gone, and the next check takes the update.
    open = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("takes the update on the next foreground once the session has closed", async () => {
    const apply = vi.fn();
    const doc = new FakeDoc();
    let open = true;
    const gate = createUpdateGate({
      sessionInProgress: async () => open,
      apply,
      doc,
      pollMs: 60 * 60_000,
    });
    gate.onNeedRefresh();
    await settle();
    open = false;
    doc.setVisibility("hidden");
    await settle();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("applies once, however many signals arrive", async () => {
    const apply = vi.fn();
    const doc = new FakeDoc();
    const gate = createUpdateGate({
      sessionInProgress: async () => false,
      apply,
      doc,
    });
    gate.onNeedRefresh();
    gate.onNeedRefresh();
    doc.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
