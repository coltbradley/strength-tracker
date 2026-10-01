// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SupersetRound, type RoundMemberCard } from "./SupersetRound";

afterEach(cleanup);

const card = (over: Partial<RoundMemberCard>): RoundMemberCard => ({
  tag: "A1",
  name: "Bench Press",
  line: "60 kg × 5",
  state: "now",
  ...over,
});

const base = (members: [RoundMemberCard, RoundMemberCard]) => (
  <SupersetRound
    heading="A1 THEN A2 · REST AFTER A2"
    members={members}
    hint="Log A1, then go straight to A2."
    picture={null}
    unit="kg"
  />
);

describe("SupersetRound", () => {
  it("L4: gives each card a name that carries its state in words, not only in a hidden glyph", () => {
    render(
      base([
        card({ state: "done" }),
        card({ tag: "A2", name: "Row", state: "now" }),
      ]),
    );
    expect(screen.getByRole("group", { name: "A1 Bench Press, 60 kg × 5, done this round" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "A2 Row, 60 kg × 5, now" })).toBeTruthy();
  });

  it("makes a pending, non-NOW card a button that chooses it next", () => {
    const onChoose = vi.fn();
    render(
      base([
        card({}),
        card({ tag: "A2", name: "Row", state: "next", onChoose }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: /^A2 Row.*Log A2 next/ }));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("H1: a skipped card offers Unskip, never a choose button", () => {
    const onUnskip = vi.fn();
    render(
      base([
        card({ state: "skipped", onUnskip }),
        card({ tag: "A2", name: "Row" }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unskip A1" }));
    expect(onUnskip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Log A1 next/ })).toBeNull();
  });
});
