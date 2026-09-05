// The cue's whole contract is what it does when it CANNOT play: nothing, and
// nothing visible. Every case here is a failure case, because the success case
// is a sound and a test cannot hear one — what it can check is that the module
// never throws out of a path the caller does not guard, and that it never
// tries to start audio outside the gesture that iOS requires.
//
// The module keeps one AudioContext for the life of the page (Safari caps how
// many a document may create), so each test re-imports it through
// `vi.resetModules()` to get that state fresh rather than reaching into it
// with a test-only export.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Cue = typeof import("./restCue");

/** Fresh module, so `ctx` starts null. */
async function loadCue(): Promise<Cue> {
  vi.resetModules();
  return (await import("./restCue")) as Cue;
}

/** Minimal AudioContext double: records what was created and started. */
function fakeAudio() {
  const started: number[] = [];
  const stopped: number[] = [];
  const oscillators: unknown[] = [];
  const resume = vi.fn(() => Promise.resolve());

  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  });

  class FakeContext {
    state: "running" | "suspended" = "running";
    currentTime = 0;
    destination = {};
    resume = resume;
    createOscillator() {
      const osc = {
        type: "sine",
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn((t: number) => started.push(t)),
        stop: vi.fn((t: number) => stopped.push(t)),
      };
      oscillators.push(osc);
      return osc;
    }
    createGain() {
      return { gain: param(), connect: vi.fn() };
    }
  }

  return { FakeContext, started, stopped, oscillators, resume };
}

const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  delete g.AudioContext;
  delete g.webkitAudioContext;
});

afterEach(() => {
  delete g.AudioContext;
  delete g.webkitAudioContext;
  vi.restoreAllMocks();
});

describe("restCue", () => {
  it("is a silent no-op when there is no AudioContext at all", async () => {
    const cue = await loadCue();
    // Neither call may throw: the callers are a tap handler and a countdown
    // effect, and neither has any use for the news.
    expect(() => cue.unlockRestCue()).not.toThrow();
    expect(() => cue.playRestCue()).not.toThrow();
  });

  it("plays nothing before the gesture unlock", async () => {
    const { FakeContext, started } = fakeAudio();
    g.AudioContext = FakeContext;
    const cue = await loadCue();

    // No unlockRestCue() call: there is no context, and creating one here is
    // exactly the move iOS refuses outside a user gesture.
    cue.playRestCue();
    expect(started).toEqual([]);
  });

  it("plays after the unlock, scheduling two blips", async () => {
    const { FakeContext, started, stopped } = fakeAudio();
    g.AudioContext = FakeContext;
    const cue = await loadCue();

    cue.unlockRestCue();
    cue.playRestCue();

    expect(started).toHaveLength(2);
    expect(started[1]).toBeGreaterThan(started[0]);
    // Every oscillator is stopped, not merely disconnected — one that is only
    // disconnected is never collected.
    expect(stopped).toHaveLength(2);
  });

  it("resumes a suspended context on unlock", async () => {
    const { FakeContext, resume } = fakeAudio();
    class Suspended extends FakeContext {
      override state: "running" | "suspended" = "suspended";
    }
    g.AudioContext = Suspended;
    const cue = await loadCue();

    cue.unlockRestCue();
    expect(resume).toHaveBeenCalled();
  });

  it("stays silent when constructing the context throws", async () => {
    g.AudioContext = class {
      constructor() {
        throw new Error("no audio for you");
      }
    };
    const cue = await loadCue();

    expect(() => cue.unlockRestCue()).not.toThrow();
    // The failed unlock must leave nothing behind that a later play would use.
    expect(() => cue.playRestCue()).not.toThrow();
  });

  it("stays silent when scheduling throws after a good unlock", async () => {
    const { FakeContext } = fakeAudio();
    class Broken extends FakeContext {
      override createOscillator(): never {
        throw new Error("gone");
      }
    }
    g.AudioContext = Broken;
    const cue = await loadCue();

    cue.unlockRestCue();
    expect(() => cue.playRestCue()).not.toThrow();
  });

  it("falls back to the webkit-prefixed constructor", async () => {
    const { FakeContext, started } = fakeAudio();
    g.webkitAudioContext = FakeContext;
    const cue = await loadCue();

    cue.unlockRestCue();
    cue.playRestCue();
    expect(started).toHaveLength(2);
  });
});
