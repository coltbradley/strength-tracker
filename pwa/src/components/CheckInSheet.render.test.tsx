// @vitest-environment jsdom
// The check-in sheet as a person meets it: a note, tags, energy, and the
// injury questions that come with Pain.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const { enqueue, enqueueBatch, inspect, toast, getInjuries, getWeekCheckins } =
  vi.hoisted(() => ({
    enqueue: vi.fn(),
    enqueueBatch: vi.fn(),
    inspect: vi.fn(),
    toast: vi.fn(),
    getInjuries: vi.fn(),
    getWeekCheckins: vi.fn(),
  }));
vi.mock("../lib/sync", () => ({ outbox: { enqueue, enqueueBatch, inspect } }));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast }));
vi.mock("../lib/supabase", () => ({ supabase: {} }));
// A full mock: importActual here would drag in checkinHistory's real
// imports (data.ts -> supabase.ts, sync.ts, db.ts, ...), which is more than
// this render test wants to boot. localDateOf and addDaysIso are re-derived
// here rather than imported, so this stays a self-contained mock.
vi.mock("../lib/checkinHistory", () => ({
  getInjuries,
  getWeekCheckins,
  localDateOf: (iso: string) => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  addDaysIso: (iso: string, n: number) => {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d + n);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  },
}));

import { CheckInSheet } from "./CheckInSheet";
import type { InjuryState } from "../lib/types";

const USER = "u1";
const TODAY = "2026-09-16";

const knee: InjuryState = {
  episode_id: "ep-knee",
  body_region: "Knee",
  side: "left",
  opened_on: "2026-09-02",
  closed_on: null,
  last_reported_at: "2026-09-15T08:00:00.000Z",
  last_reported_on: "2026-09-15",
  reports: 2,
  state: "active",
};

function open() {
  const onClose = vi.fn();
  render(<CheckInSheet userId={USER} localDate={TODAY} onClose={onClose} />);
  return { onClose };
}

const submit = () =>
  screen.getByRole("button", { name: "Check in" }) as HTMLButtonElement;
const tag = (name: string) => screen.getByRole("button", { name });
// No jest-dom in this project (no other test uses it) -- these read the same
// DOM state toBeDisabled/toBeEnabled/toHaveAttribute would, without adding a
// dependency.
const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
const pressed = (el: HTMLElement) => el.getAttribute("aria-pressed");

afterEach(cleanup);
beforeEach(() => {
  for (const f of [
    enqueue,
    enqueueBatch,
    inspect,
    toast,
    getInjuries,
    getWeekCheckins,
  ])
    f.mockReset();
  enqueue.mockResolvedValue(undefined);
  enqueueBatch.mockResolvedValue(undefined);
  inspect.mockResolvedValue([]);
  getInjuries.mockResolvedValue({ data: [], fromCache: false });
  getWeekCheckins.mockResolvedValue({ data: [], fromCache: false });
});

describe("CheckInSheet", () => {
  it("puts the note first and disables Check in until something is filled in", async () => {
    open();
    const note = screen.getByLabelText("How are you feeling?");
    const labels = screen
      .getAllByText(/How are you feeling\?|Tags|Energy/)
      .map((n) => n.textContent);
    expect(labels[0]).toBe("How are you feeling?");
    expect(isDisabled(submit())).toBe(true);
    fireEvent.change(note, { target: { value: "hips tight" } });
    expect(isDisabled(submit())).toBe(false);
  });

  it("enables Check in for a tag alone and for energy alone", () => {
    open();
    fireEvent.click(tag("Great"));
    expect(isDisabled(submit())).toBe(false);
    fireEvent.click(tag("Great"));
    expect(isDisabled(submit())).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Energy 2 of 5" }));
    expect(isDisabled(submit())).toBe(false);
  });

  it("queues one check-in with tags and energy, then closes", async () => {
    const { onClose } = open();
    fireEvent.click(tag("Stressed"));
    fireEvent.click(screen.getByRole("button", { name: "Energy 3 of 5" }));
    fireEvent.click(submit());
    await waitFor(() => expect(enqueueBatch).toHaveBeenCalledTimes(1));
    const ops = enqueueBatch.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    expect(ops[0].payload).toMatchObject({
      user_id: USER,
      tags: ["stressed"],
      energy: 3,
      note: null,
    });
    expect(toast).toHaveBeenCalledWith("Checked in");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the pain questions only while Pain is on, and clears them when it goes off", () => {
    open();
    expect(screen.queryByText("Where")).toBeNull();
    fireEvent.click(tag("Pain"));
    fireEvent.click(screen.getByRole("button", { name: "Ankle" }));
    expect(pressed(screen.getByRole("button", { name: "Ankle" }))).toBe("true");
    fireEvent.click(tag("Pain"));
    expect(screen.queryByText("Where")).toBeNull();
    fireEvent.click(tag("Pain"));
    expect(pressed(screen.getByRole("button", { name: "Ankle" }))).toBe(
      "false",
    );
  });

  it("opens a new injury ahead of the check-in when nothing matches", async () => {
    open();
    fireEvent.click(tag("Pain"));
    fireEvent.click(screen.getByRole("button", { name: "Hip" }));
    fireEvent.click(screen.getByRole("button", { name: "Right" }));
    fireEvent.click(screen.getByRole("button", { name: "Modified" }));
    fireEvent.click(submit());
    await waitFor(() => expect(enqueueBatch).toHaveBeenCalled());
    const ops = enqueueBatch.mock.calls[0][0];
    expect(ops.map((o: { table: string }) => o.table)).toEqual([
      "symptom_episodes",
      "checkins",
    ]);
    expect(ops[1].payload.episode_id).toBe(ops[0].payload.id);
    expect(ops[1].payload.training_impact).toBe("modified");
  });

  it("says which injury a pain answer adds to", async () => {
    getInjuries.mockResolvedValue({ data: [knee], fromCache: false });
    open();
    await screen.findByText(/Still feeling your left knee\?/);
    fireEvent.click(tag("Pain"));
    fireEvent.click(screen.getByRole("button", { name: "Knee" }));
    fireEvent.click(screen.getByRole("button", { name: "Left" }));
    expect(screen.getByText(/Adds to left knee/)).toBeTruthy();
  });

  it("Still there fills in Pain, region and side", async () => {
    getInjuries.mockResolvedValue({ data: [knee], fromCache: false });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Still there" }));
    expect(pressed(tag("Pain"))).toBe("true");
    expect(pressed(screen.getByRole("button", { name: "Knee" }))).toBe("true");
    expect(pressed(screen.getByRole("button", { name: "Left" }))).toBe("true");
  });

  it("Cleared up queues the close on its own and hides the question", async () => {
    getInjuries.mockResolvedValue({ data: [knee], fromCache: false });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Cleared up" }));
    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith({
        kind: "update",
        table: "symptom_episodes",
        id: "ep-knee",
        patch: { closed_on: TODAY },
      }),
    );
    expect(screen.queryByText(/Still feeling your left knee\?/)).toBeNull();
  });

  it("does not ask about an injury already reported today", async () => {
    getInjuries.mockResolvedValue({
      data: [{ ...knee, last_reported_on: TODAY }],
      fromCache: false,
    });
    open();
    await waitFor(() => expect(getInjuries).toHaveBeenCalled());
    expect(screen.queryByText(/Still feeling/)).toBeNull();
  });

  it("lists today's earlier check-ins", async () => {
    getWeekCheckins.mockResolvedValue({
      data: [
        {
          id: "a",
          recorded_at: new Date(2026, 8, 16, 7, 18).toISOString(),
          note: null,
          energy: 3,
          tags: [],
          training_impact: null,
          episode_id: null,
        },
        {
          id: "b",
          recorded_at: new Date(2026, 8, 15, 20, 0).toISOString(),
          note: null,
          energy: 1,
          tags: [],
          training_impact: null,
          episode_id: null,
        },
      ],
      fromCache: false,
    });
    open();
    const earlier = await screen.findByLabelText("Earlier today");
    // Only the energy scores, not the times, which contain digits too.
    const scores = [...earlier.querySelectorAll("b")].map((b) => b.textContent);
    expect(scores).toEqual(["3"]);
  });
});
