// @vitest-environment jsdom
//
// The rest strip announces itself ONCE per rest, and only from an effect.
//
// Two bugs sat here. The notification was raised from the render body, so a
// render React went on to discard could still fire a system notification —
// the ref guard is no protection against that, because the ref is set by the
// same discarded render. And the tick effect was keyed on the whole `rest`
// object, which −30/+30 rebuilds by spread; every adjustment therefore reset
// the already-told-them flag, and a rest that had gone over announced itself
// again on the next tap. Both are invisible in normal use and both are
// exactly the sort of thing that goes off in a quiet gym.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RestTimer, type ActiveRest } from "./RestTimer";

const noop = () => {};

/** A rest that started far enough back to already be over.
 *
 *  `startedAt` IS the rest's identity, so every call must produce a distinct
 *  one. The separation is a whole minute per call rather than a millisecond
 *  because it has to be bigger than any time that can pass BETWEEN two calls:
 *  at `- nth` a single millisecond of real elapsed time cancelled the offset
 *  exactly, both rests got the same startedAt, the second announcement was
 *  correctly suppressed, and this file failed about one run in three. */
let nth = 0;
function overdue(targetSeconds = 60): ActiveRest {
  nth += 1;
  return {
    startedAt: Date.now() - (targetSeconds + 30) * 1000 - nth * 60_000,
    targetSeconds,
    forLabel: "Barbell Row set 2",
  };
}

let notified: string[];

beforeEach(() => {
  notified = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title: string) {
      notified.push(title);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RestTimer", () => {
  it("renders nothing when no rest is running", () => {
    const { container } = render(
      <RestTimer rest={null} onAdjust={noop} onEdit={noop} onDone={noop} />,
    );
    expect(container.querySelector(".rest-timer")).toBeNull();
  });

  it("marks the active rest state for its distinct orange treatment", () => {
    const { container, rerender } = render(
      <RestTimer
        rest={{ startedAt: Date.now(), targetSeconds: 60, forLabel: "Squat set 2" }}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
      />,
    );

    expect(container.querySelector(".rest-timer")?.classList.contains("rest-timer-rest")).toBe(true);
    rerender(
      <RestTimer rest={overdue()} onAdjust={noop} onEdit={noop} onDone={noop} />,
    );
    const ready = container.querySelector(".rest-timer");
    expect(ready?.classList.contains("rest-timer-ready")).toBe(true);
    expect(ready?.classList.contains("rest-timer-rest")).toBe(false);
  });

  it("re-enters the rest animation for each newly logged rest identity", () => {
    const firstRest = {
      startedAt: Date.now(),
      targetSeconds: 60,
      forLabel: "Squat set 2",
    };
    const { container, rerender } = render(
      <RestTimer rest={firstRest} onAdjust={noop} onEdit={noop} onDone={noop} />,
    );
    const firstNode = container.querySelector(".rest-timer");

    rerender(
      <RestTimer
        rest={{ ...firstRest, startedAt: firstRest.startedAt + 1_000 }}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
      />,
    );

    const nextNode = container.querySelector(".rest-timer");
    expect(nextNode).not.toBe(firstNode);
    expect(nextNode?.classList.contains("rest-timer-enter")).toBe(true);
  });

  it("announces an overdue rest exactly once", () => {
    const rest = overdue();
    const { rerender } = render(
      <RestTimer rest={rest} onAdjust={noop} onEdit={noop} onDone={noop} />,
    );
    // same rest, re-rendered: the announcement must not repeat
    rerender(
      <RestTimer rest={rest} onAdjust={noop} onEdit={noop} onDone={noop} />,
    );
    expect(notified).toEqual(["Rest over"]);
  });

  it("does not announce again when the target is adjusted", () => {
    const rest = overdue();
    const { rerender } = render(
      <RestTimer rest={rest} onAdjust={noop} onEdit={noop} onDone={noop} />,
    );
    expect(notified).toHaveLength(1);

    // what onAdjust actually does: a NEW object, same startedAt. This used to
    // restart the interval effect and clear the flag.
    for (const delta of [30, 30, -30]) {
      rerender(
        <RestTimer
          rest={{ ...rest, targetSeconds: rest.targetSeconds + delta }}
          onAdjust={noop}
          onEdit={noop}
          onDone={noop}
        />,
      );
    }
    expect(notified).toEqual(["Rest over"]);
  });

  it("announces again for a genuinely new rest", () => {
    const { rerender } = render(
      <RestTimer
        rest={overdue()}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
      />,
    );
    // a different startedAt is a different rest, and deserves its own
    rerender(
      <RestTimer
        rest={overdue()}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
      />,
    );
    expect(notified).toHaveLength(2);
  });

  it("stays silent while the rest is still running", () => {
    const running: ActiveRest = {
      startedAt: Date.now(),
      targetSeconds: 120,
      forLabel: "Back Squat set 1",
    };
    render(
      <RestTimer rest={running} onAdjust={noop} onEdit={noop} onDone={noop} />,
    );
    expect(notified).toEqual([]);
  });

  it("never prompts for permission it was not already given", () => {
    const asked = vi.fn();
    class Denied {
      static permission = "default";
      static requestPermission = asked;
      constructor() {
        notified.push("should not happen");
      }
    }
    vi.stubGlobal("Notification", Denied);
    render(
      <RestTimer
        rest={overdue()}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
      />,
    );
    expect(notified).toEqual([]);
    expect(asked).not.toHaveBeenCalled();
  });

  it("clears its interval on unmount", () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(
      <RestTimer
        rest={overdue()}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
      />,
    );
    act(() => unmount());
    expect(clear).toHaveBeenCalled();
  });

  it("names what the rest was recorded against when there is nothing to look forward to", () => {
    render(
      <RestTimer
        rest={{
          startedAt: Date.now(),
          targetSeconds: 90,
          forLabel: "Squat set 2",
        }}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
        nextSetLabel={null}
      />,
    );
    expect(screen.getByText(/Recorded against Squat set 2\./)).toBeTruthy();
  });

  it("looks forward to the next set instead, when one is given", () => {
    render(
      <RestTimer
        rest={{
          startedAt: Date.now(),
          targetSeconds: 90,
          forLabel: "Squat set 2",
        }}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
        nextSetLabel="Next: Squat 145 × 5, set 3 of 4"
      />,
    );
    expect(screen.getByText("Next: Squat 145 × 5, set 3 of 4")).toBeTruthy();
    expect(screen.queryByText(/Recorded against/)).toBeNull();
  });

  it("shows READY once the target has elapsed", () => {
    render(
      <RestTimer
        rest={overdue()}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
        nextSetLabel="Next: Squat 145 × 5, set 3 of 4"
      />,
    );
    expect(screen.getByText("READY")).toBeTruthy();
    expect(screen.queryByText(/Past the prescribed/)).toBeNull();
  });

  it("changes REST to READY once at expiry and never advances the workout by itself", () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const start = Date.now();
    render(
      <RestTimer
        rest={{ startedAt: start, targetSeconds: 2, forLabel: "Squat set 1" }}
        onAdjust={noop}
        onEdit={noop}
        onDone={onDone}
        nextSetLabel="Next: Squat set 2 of 3"
      />,
    );

    expect(screen.getByText("REST")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2_100));

    expect(screen.getByText("READY")).toBeTruthy();
    expect(screen.getByText("Next: Squat set 2 of 3")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("offers optional RPE and set-note actions in the rest scene", () => {
    const onRateLastSet = vi.fn();
    const onNoteLastSet = vi.fn();
    render(
      <RestTimer
        rest={{ startedAt: Date.now(), targetSeconds: 90, forLabel: "Squat set 1" }}
        onAdjust={noop}
        onEdit={noop}
        onDone={noop}
        lastSetRpe={null}
        onRateLastSet={onRateLastSet}
        onNoteLastSet={onNoteLastSet}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Note last set" }));
    fireEvent.click(screen.getByRole("button", { name: "rpe 8" }));
    expect(onNoteLastSet).toHaveBeenCalledTimes(1);
    expect(onRateLastSet).toHaveBeenCalledWith(8);
  });
});
