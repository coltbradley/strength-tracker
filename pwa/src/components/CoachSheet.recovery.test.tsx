// @vitest-environment jsdom
// A reopened sheet polls for an answer it was not connected for (up to ~24 s).
// Ask stays enabled meanwhile, so a new question can land first; the recovered
// answer must go to ITS turn, never onto the new placeholder that is now last.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

let resolvePoll: (v: { kind: "answer"; text: string }) => void = () => {};

vi.mock("../lib/coach", async (orig) => {
  const real = await orig<typeof import("../lib/coach")>();
  return {
    ...real,
    askCoach: vi.fn(() => new Promise(() => {})),
    getCoachSpend: vi.fn(() => Promise.resolve(null)),
    newTurnId: vi.fn(() => "turn-new"),
    pollForAnswer: vi.fn(
      () =>
        new Promise((r) => {
          resolvePoll = r;
        }),
    ),
  };
});
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));

import { CoachSheet } from "./CoachSheet";
import { COACH_THREAD_KEY } from "../lib/db";

describe("CoachSheet recovery", () => {
  beforeEach(() => {
    // jsdom has no layout; the sheet scrolls its last message into view.
    Element.prototype.scrollIntoView = vi.fn();
    localStorage.clear();
    localStorage.setItem(
      COACH_THREAD_KEY,
      JSON.stringify([
        { role: "user", text: "old question" },
        { role: "assistant", text: "", turnId: "turn-old", streaming: true },
      ]),
    );
  });

  it("FINAL-1: a recovered answer patches its own turn, not a newer one", async () => {
    render(
      <MemoryRouter>
        <CoachSheet onClose={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Message to your coach"), {
      target: { value: "new question" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ask$/i }));

    await act(async () => {
      resolvePoll({ kind: "answer", text: "OLD ANSWER" });
    });

    const saved = JSON.parse(localStorage.getItem(COACH_THREAD_KEY) ?? "[]");
    const old = saved.find((m: { turnId?: string }) => m.turnId === "turn-old");
    const fresh = saved.find((m: { turnId?: string }) => m.turnId === "turn-new");
    expect(old.text).toBe("OLD ANSWER");
    expect(old.streaming).toBeUndefined();
    expect(fresh.text).not.toContain("OLD ANSWER");
    expect(fresh.streaming).toBe(true);
  });
});
