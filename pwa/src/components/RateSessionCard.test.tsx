// @vitest-environment jsdom
//
// The rate-this-session card.
//
// The behaviour worth pinning is all NEGATIVE: the card must not appear when
// the question has already been answered. A prompt that comes back asking for
// a number someone already gave is worse than no prompt, because it reads as
// the app having lost the answer — and this one has three separate ways of
// finding out that it has been answered.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const getUnratedSession = vi.fn();
const rateSession = vi.fn();
const pendingRatedSessionIds = vi.fn();

vi.mock("../lib/data", () => ({
  getUnratedSession: (...a: unknown[]) => getUnratedSession(...a),
  rateSession: (...a: unknown[]) => rateSession(...a),
}));
vi.mock("../lib/sync", () => ({
  outbox: { pendingRatedSessionIds: () => pendingRatedSessionIds() },
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn() }));

import { RateSessionCard, whenLabel } from "./RateSessionCard";
import { cacheKeys, cacheGet, cacheSet, resetDbForTests } from "../lib/db";

const SESS = "11111111-2222-3333-4444-555555555555";
const row = (over: Record<string, unknown> = {}) => ({
  id: SESS,
  ended_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  planned_workout_id: null,
  ...over,
});

afterEach(cleanup);

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  vi.clearAllMocks();
  getUnratedSession.mockResolvedValue(row());
  rateSession.mockResolvedValue(undefined);
  pendingRatedSessionIds.mockResolvedValue(new Set<string>());
});

describe("whenLabel", () => {
  const now = Date.parse("2026-09-06T20:00:00Z");
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();

  it("is coarse on purpose, and never claims a time it cannot know", () => {
    expect(whenLabel(ago(1), now)).toBe("EARLIER TODAY");
    expect(whenLabel(ago(8), now)).toBe("THIS MORNING");
    expect(whenLabel(ago(20), now)).toBe("YESTERDAY");
  });
});

describe("RateSessionCard", () => {
  it("asks when a finished session inside the window has no rating", async () => {
    render(<RateSessionCard />);
    expect(await screen.findByLabelText("session rpe 7")).toBeTruthy();
  });

  it("renders nothing when there is no unrated session", async () => {
    getUnratedSession.mockResolvedValue(null);
    const { container } = render(<RateSessionCard />);
    await waitFor(() => expect(getUnratedSession).toHaveBeenCalled());
    expect(container.querySelector(".rate-card")).toBeNull();
  });

  it("does not ask again for a rating still sitting in the outbox", async () => {
    // The server has not heard about a rating given in a basement gym, so
    // getUnratedSession still returns it. The queue is the other half of the
    // answer, and without this the card comes straight back.
    pendingRatedSessionIds.mockResolvedValue(new Set([SESS]));
    const { container } = render(<RateSessionCard />);
    await waitFor(() => expect(pendingRatedSessionIds).toHaveBeenCalled());
    expect(container.querySelector(".rate-card")).toBeNull();
  });

  it("does not ask again after 'Not now', across a remount", async () => {
    const first = render(<RateSessionCard />);
    await screen.findByText("Not now");
    fireEvent.click(screen.getByText("Not now"));
    await waitFor(() =>
      expect(first.container.querySelector(".rate-card")).toBeNull(),
    );
    expect(await cacheGet(cacheKeys.rateSkipped(SESS))).toBe(true);

    // Navigating back to Today remounts this component; the decline has to
    // survive that or it was never a decline.
    first.unmount();
    const again = render(<RateSessionCard />);
    await waitFor(() => expect(getUnratedSession).toHaveBeenCalledTimes(2));
    expect(again.container.querySelector(".rate-card")).toBeNull();
  });

  it("a skip recorded on a previous run is honoured on the first render", async () => {
    await cacheSet(cacheKeys.rateSkipped(SESS), true);
    const { container } = render(<RateSessionCard />);
    await waitFor(() => expect(getUnratedSession).toHaveBeenCalled());
    expect(container.querySelector(".rate-card")).toBeNull();
  });

  it("queues the rating and clears itself on the tap", async () => {
    const { container } = render(<RateSessionCard />);
    fireEvent.click(await screen.findByLabelText("session rpe 8"));
    expect(rateSession).toHaveBeenCalledWith(SESS, 8);
    // The outbox owns the write now. Leaving the card up would read as if the
    // tap had not registered.
    await waitFor(() =>
      expect(container.querySelector(".rate-card")).toBeNull(),
    );
  });

  it("offers 0 through 10 — the SESSION scale, not the per-set one", async () => {
    // The per-set chips floor at 6.5. A session at 0 is a real answer.
    render(<RateSessionCard />);
    await screen.findByLabelText("session rpe 0");
    expect(screen.getByLabelText("session rpe 10")).toBeTruthy();
    expect(screen.queryByLabelText("session rpe 6.5")).toBeNull();
  });

  it("a failed load leaves the screen alone rather than throwing", async () => {
    getUnratedSession.mockRejectedValue(new Error("offline"));
    const { container } = render(<RateSessionCard />);
    await waitFor(() => expect(getUnratedSession).toHaveBeenCalled());
    expect(container.querySelector(".rate-card")).toBeNull();
  });
});
