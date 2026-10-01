// @vitest-environment jsdom
//
// D3: the End screen's two tiles are receipts, not hopes. ON SERVER counts
// only sets the server returned by exact UUID (lib/finishedProof); a screen
// that cannot read that proof says "checking…" / "offline" and never a number.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  online: true,
  owner: "user-1" as string | null,
  proof: vi.fn(),
  serverCount: vi.fn(),
}));

vi.mock("../hooks/useFabDrag", () => ({ useOnline: () => h.online }));
vi.mock("../hooks/useUnit", () => ({ useUnit: () => "kg" }));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/currentUser", () => ({ getCurrentUserId: () => h.owner }));
vi.mock("../lib/finishedProof", () => ({
  readFinishedSessionProof: (...a: unknown[]) => h.proof(...a),
}));
vi.mock("../lib/data", () => ({
  countServerSessionSets: () => h.serverCount(),
  invalidateForSessionClose: vi.fn().mockResolvedValue(undefined),
  invalidateForSetChange: vi.fn().mockResolvedValue(undefined),
  resolveSessionSetCount: (local: number, server: number | null) =>
    local > 0
      ? { count: local, authoritative: true }
      : server === null
        ? { count: 0, authoritative: false }
        : { count: server, authoritative: true },
}));
vi.mock("../lib/sync", () => ({
  outbox: {
    pendingSets: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn(() => () => undefined),
    inspect: vi.fn().mockResolvedValue([]),
    enqueue: vi.fn().mockResolvedValue(undefined),
    enqueueBatch: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

import { End, endReceipts } from "./End";
import { cacheKeys, cacheSet, resetDbForTests } from "../lib/db";

const ACTIVE = {
  id: "sess-r",
  planned_workout_id: "w-1",
  started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
  workout_label: "Lower",
  plan_note: null,
  coach_note: null,
};
const set = (n: number) => ({
  id: `set-${n}`,
  session_id: ACTIVE.id,
  exercise_id: "squat",
  prescription_id: null,
  set_index: n,
  set_type: "working",
  load_kg: 100,
  reps: 5,
  performed_at: ACTIVE.started_at,
  rest_seconds_actual: null,
});

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  h.online = true;
  h.owner = "user-1";
  h.proof.mockReset().mockResolvedValue(null);
  h.serverCount.mockReset().mockResolvedValue(0);
  await cacheSet(cacheKeys.activeSession, ACTIVE);
  await cacheSet(cacheKeys.sessionSets(ACTIVE.id), [set(0), set(1), set(2)]);
});
afterEach(() => cleanup());

const renderEnd = () =>
  render(
    <MemoryRouter>
      <End />
    </MemoryRouter>,
  );
const tiles = () => screen.getByRole("region", { name: /Where this session/ });

describe("endReceipts", () => {
  it("is known only from a proof or a server-confirmed zero", () => {
    expect(
      endReceipts({
        proof: { sets: 3, confirmed: 2, unconfirmed: 1 },
        confirmedEmpty: false,
        online: true,
        readSettled: true,
      }),
    ).toEqual({ known: true, onServer: 2, onPhone: 1 });
    expect(
      endReceipts({ proof: null, confirmedEmpty: true, online: false, readSettled: false }),
    ).toEqual({ known: true, onServer: 0, onPhone: 0 });
    expect(
      endReceipts({ proof: null, confirmedEmpty: false, online: true, readSettled: false }),
    ).toEqual({ known: false, reason: "checking" });
    expect(
      endReceipts({ proof: null, confirmedEmpty: false, online: false, readSettled: false }),
    ).toEqual({ known: false, reason: "offline" });
    expect(
      endReceipts({ proof: null, confirmedEmpty: false, online: true, readSettled: true }),
    ).toEqual({ known: false, reason: "unavailable" });
  });
});

describe("End screen (Version D)", () => {
  it("leads with the moment, a summary line and the two receipt tiles from exact-UUID proof", async () => {
    h.proof.mockResolvedValue({ sets: 3, confirmed: 2, unconfirmed: 1 });
    renderEnd();
    expect(
      await screen.findByRole("heading", { name: "That’s the session." }),
    ).toBeTruthy();
    await screen.findByText(/3 SETS LOGGED/);
    await vi.waitFor(() => {
      const t = within(tiles());
      expect(t.getByText("✓ ON SERVER").nextElementSibling?.textContent).toBe("2");
      expect(t.getByText("◐ ON PHONE").nextElementSibling?.textContent).toBe("1");
    });
    expect(h.proof).toHaveBeenCalledWith(ACTIVE.id, "user-1");
    expect(screen.getByText("How hard was it overall?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Bodyweight" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Note" })).toBeTruthy();
    expect(screen.getByText(/Sets still on this phone keep sending after you end/)).toBeTruthy();
  });

  it("says checking… and shows no server number until the proof lands", async () => {
    h.proof.mockReturnValue(new Promise(() => undefined));
    renderEnd();
    await screen.findByText(/3 SETS LOGGED/);
    const t = within(tiles());
    expect(t.getByText("✓ ON SERVER").nextElementSibling?.textContent).toBe("—");
    expect(t.getAllByText("checking…").length).toBeGreaterThan(0);
  });

  it("never claims the server while offline and does not even ask", async () => {
    h.online = false;
    renderEnd();
    await screen.findByText(/3 SETS LOGGED/);
    const t = within(tiles());
    expect(t.getByText("✓ ON SERVER").nextElementSibling?.textContent).toBe("—");
    expect(t.getByText(/offline/i)).toBeTruthy();
    expect(h.proof).not.toHaveBeenCalled();
  });

  it("does not claim the server when the proof read failed", async () => {
    h.proof.mockResolvedValue(null);
    renderEnd();
    await screen.findByText(/3 SETS LOGGED/);
    await vi.waitFor(() => expect(screen.getByText("can’t confirm yet")).toBeTruthy());
    expect(
      within(tiles()).getByText("✓ ON SERVER").nextElementSibling?.textContent,
    ).toBe("—");
  });

  it("a SERVER-confirmed zero is 0 and 0, with Discard leading as before", async () => {
    await cacheSet(cacheKeys.sessionSets(ACTIVE.id), []);
    h.serverCount.mockResolvedValue(0);
    renderEnd();
    expect(
      await screen.findByRole("button", { name: "Discard empty session" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "End anyway (counts as done)" })).toBeTruthy();
    const t = within(tiles());
    expect(t.getByText("✓ ON SERVER").nextElementSibling?.textContent).toBe("0");
    expect(t.getByText("◐ ON PHONE").nextElementSibling?.textContent).toBe("0");
  });

  it("an unconfirmed local zero is not an empty session: no Discard, no 0 on the server", async () => {
    await cacheSet(cacheKeys.sessionSets(ACTIVE.id), []);
    h.serverCount.mockRejectedValue(new Error("offline"));
    renderEnd();
    await screen.findByText(/couldn’t reach the server/i);
    expect(screen.queryByRole("button", { name: "Discard empty session" })).toBeNull();
    expect(screen.getByRole("button", { name: "End session" })).toBeTruthy();
    expect(
      within(tiles()).getByText("✓ ON SERVER").nextElementSibling?.textContent,
    ).toBe("—");
  });
});
