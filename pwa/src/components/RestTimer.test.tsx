// @vitest-environment jsdom
//
// The rest clock has ONE API with two presentations (panel, strip). The tone
// and notification are not the component's job: useRestCue is mounted once by
// Session and remembers announced rests in module scope, so a rest is told
// once however often a sheet, the Focus/List switch or a remount rebuilds the
// clock (H2). "End rest now" is the lifter's own act and stays silent (L1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const played = vi.hoisted(() => vi.fn());
vi.mock("../lib/restCue", () => ({ playRestCue: played }));
vi.mock("../lib/settings", async (orig) => ({
  ...(await orig<typeof import("../lib/settings")>()),
  getRestSound: () => true,
}));

import {
  RestDockTag,
  RestTimer,
  resetRestCuesForTests,
  restAnnounced,
  silenceRestCue,
  useRestCue,
  type ActiveRest,
} from "./RestTimer";

const noop = () => {};

/** `startedAt` IS the rest's identity: every call must be distinct. */
let nth = 0;
function overdue(targetSeconds = 60): ActiveRest {
  nth += 1;
  return {
    startedAt: Date.now() - (targetSeconds + 2) * 1000 - nth * 37,
    targetSeconds,
    forLabel: "Barbell Row set 2",
  };
}
const running = (targetSeconds = 90): ActiveRest => ({
  startedAt: Date.now(),
  targetSeconds,
  forLabel: "Squat set 2",
});

let notified: string[];

beforeEach(() => {
  notified = [];
  played.mockClear();
  resetRestCuesForTests();
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

function Cue({ rest, body = null }: { rest: ActiveRest | null; body?: string | null }) {
  useRestCue(rest, body);
  return null;
}

describe("RestTimer panel", () => {
  it("renders nothing without a rest", () => {
    const { container } = render(
      <RestTimer rest={null} onAdjust={noop} onEdit={noop} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the big clock with -30/+30 while resting", () => {
    const onAdjust = vi.fn();
    const onEdit = vi.fn();
    const { container } = render(
      <RestTimer rest={running()} onAdjust={onAdjust} onEdit={onEdit} />,
    );
    expect(container.querySelector(".rest-panel")).not.toBeNull();
    expect(screen.getByText("◷ RESTING")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "take 30 seconds off the rest target" }));
    fireEvent.click(screen.getByRole("button", { name: "add 30 seconds to the rest target" }));
    expect(onAdjust.mock.calls).toEqual([[-30], [30]]);
    fireEvent.click(screen.getByRole("button", { name: /^rest remaining/ }));
    expect(onEdit).toHaveBeenCalled();
  });

  it("turns into a REST OVER card with elapsed and target once the target passes", () => {
    const onEdit = vi.fn();
    render(<RestTimer rest={overdue(60)} onAdjust={noop} onEdit={onEdit} />);
    expect(screen.getByText("■ REST OVER")).toBeTruthy();
    expect(screen.getByText(/since the last set · target 1:00/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Rest over/);
    fireEvent.click(screen.getByRole("button", { name: "rest over — tap to change the target" }));
    expect(onEdit).toHaveBeenCalled();
  });

  it("shows a single-line next-set label under the clock, resting and ready", () => {
    const { rerender } = render(
      <RestTimer rest={running()} onAdjust={noop} onEdit={noop} nextSetLabel="Next: Row · set 3 of 4" />,
    );
    expect(screen.getByText("Next: Row · set 3 of 4")).toBeTruthy();
    rerender(
      <RestTimer rest={overdue()} onAdjust={noop} onEdit={noop} nextSetLabel="Next: Row · set 3 of 4" />,
    );
    expect(screen.getByText("Next: Row · set 3 of 4")).toBeTruthy();
  });

  it("does not play or notify by itself: announcing is useRestCue's job", () => {
    render(<RestTimer rest={overdue()} onAdjust={noop} onEdit={noop} />);
    expect(played).not.toHaveBeenCalled();
    expect(notified).toEqual([]);
  });
});

describe("RestTimer strip", () => {
  it("marks the active and completed states", () => {
    const { container, rerender } = render(
      <RestTimer variant="strip" rest={running(60)} onAdjust={noop} onEdit={noop} onDone={noop} />,
    );
    expect(container.querySelector(".rest-timer-rest")).not.toBeNull();
    rerender(
      <RestTimer variant="strip" rest={overdue()} onAdjust={noop} onEdit={noop} onDone={noop} />,
    );
    expect(container.querySelector(".rest-timer-ready")).not.toBeNull();
    expect(screen.getByText("■ REST OVER")).toBeTruthy();
  });

  it("makes hiding explicit and optional", () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <RestTimer variant="strip" rest={running()} onAdjust={noop} onEdit={noop} onDone={onDone} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /hide the rest timer/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
    rerender(<RestTimer variant="strip" rest={running()} onAdjust={noop} onEdit={noop} />);
    expect(screen.queryByRole("button", { name: /hide the rest timer/ })).toBeNull();
  });

  it("names what the rest is recorded against when there is no next set", () => {
    render(<RestTimer variant="strip" rest={running()} onAdjust={noop} onEdit={noop} />);
    expect(screen.getByText(/Recorded against Squat set 2/)).toBeTruthy();
  });
});

describe("useRestCue", () => {
  it("H2: announces an overdue rest once, even across remounts", () => {
    const rest = overdue();
    const first = render(<Cue rest={rest} />);
    expect(played).toHaveBeenCalledTimes(1);
    expect(notified).toEqual(["Rest over"]);
    first.unmount();
    render(<Cue rest={rest} />);
    expect(played).toHaveBeenCalledTimes(1);
    expect(notified).toEqual(["Rest over"]);
    expect(restAnnounced(rest.startedAt)).toBe(true);
  });

  it("does not announce again when the target is adjusted", () => {
    const rest = overdue(60);
    const { rerender } = render(<Cue rest={rest} />);
    rerender(<Cue rest={{ ...rest, targetSeconds: 90 }} />);
    rerender(<Cue rest={{ ...rest, targetSeconds: 30 }} />);
    expect(played).toHaveBeenCalledTimes(1);
  });

  it("announces again for a genuinely new rest", () => {
    const { rerender } = render(<Cue rest={overdue()} />);
    rerender(<Cue rest={null} />);
    rerender(<Cue rest={overdue()} />);
    expect(played).toHaveBeenCalledTimes(2);
  });

  it("stays silent while the rest is running, then fires at the deadline", () => {
    vi.useFakeTimers();
    render(<Cue rest={{ startedAt: Date.now(), targetSeconds: 60, forLabel: "x" }} />);
    expect(played).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(played).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(played).toHaveBeenCalledTimes(1);
  });

  it("uses the next-set text as the notification body", () => {
    const bodies: string[] = [];
    class N {
      static permission = "granted";
      constructor(_t: string, o?: { body?: string }) {
        bodies.push(o?.body ?? "");
      }
    }
    vi.stubGlobal("Notification", N);
    render(<Cue rest={overdue()} body="Next: Row · set 3 of 4" />);
    expect(bodies).toEqual(["Next: Row · set 3 of 4"]);
  });

  it("N7: a rest that ended long ago says nothing on a cold open", () => {
    const stale: ActiveRest = {
      startedAt: Date.now() - 20 * 60_000,
      targetSeconds: 90,
      forLabel: "x",
    };
    render(<Cue rest={stale} />);
    expect(played).not.toHaveBeenCalled();
    expect(notified).toEqual([]);
  });

  it("N8: +30 after the rest is over re-arms the announcement for the new deadline", () => {
    vi.useFakeTimers();
    const rest = overdue(60);
    const { rerender } = render(<Cue rest={rest} />);
    expect(played).toHaveBeenCalledTimes(1);
    rerender(<Cue rest={{ ...rest, targetSeconds: 90 }} />);
    expect(played).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(played).toHaveBeenCalledTimes(2);
    // shortening it again is not a new announcement
    rerender(<Cue rest={{ ...rest, targetSeconds: 30 }} />);
    expect(played).toHaveBeenCalledTimes(2);
  });

  it("never prompts for permission it was not already given", () => {
    const request = vi.fn();
    class N {
      static permission = "default";
      static requestPermission = request;
    }
    vi.stubGlobal("Notification", N);
    render(<Cue rest={overdue()} />);
    expect(request).not.toHaveBeenCalled();
    expect(played).toHaveBeenCalledTimes(1);
  });

  it("L1: a silenced rest (End rest now) makes no sound", () => {
    const rest = overdue();
    silenceRestCue(rest.startedAt);
    render(<Cue rest={rest} />);
    expect(played).not.toHaveBeenCalled();
    expect(notified).toEqual([]);
  });
});

describe("RestDockTag", () => {
  it("shows the label and End rest now while the rest runs, reporting whole elapsed seconds", () => {
    const onEndNow = vi.fn();
    const rest = { startedAt: Date.now() - 12_900, targetSeconds: 90, forLabel: "x" };
    render(<RestDockTag rest={rest} label="NEXT SET · SET 2 OF 3" onEndNow={onEndNow} />);
    expect(screen.getByText("NEXT SET · SET 2 OF 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End rest now ›" }));
    expect(onEndNow).toHaveBeenCalledWith(12);
  });

  it("keeps the label but hides End rest now once the rest is over", () => {
    render(<RestDockTag rest={overdue()} label="NEXT SET" onEndNow={noop} />);
    expect(screen.getByText("NEXT SET")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /End rest now/ })).toBeNull();
  });
});
