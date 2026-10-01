// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetReceiptStatus, receiptKind } from "./SetReceiptStatus";

afterEach(cleanup);

describe("receiptKind — each word has to be earned", () => {
  it("is Saved only for a synced receipt", () => {
    expect(receiptKind({ state: "synced" })).toBe("synced");
    // a queue that is sending says nothing about a set the server confirmed
    expect(receiptKind({ state: "synced" }, { sending: true })).toBe("synced");
  });

  it("is On this phone for a local receipt, Sending only while the queue is flushing, Held when it may not send", () => {
    expect(receiptKind({ state: "local" })).toBe("local");
    expect(receiptKind({ state: "local" }, { sending: true })).toBe("sending");
    expect(receiptKind({ state: "local" }, { sending: true, held: true })).toBe("held");
  });

  it("a review receipt is never softened by a flushing queue", () => {
    expect(receiptKind({ state: "review", reason: "x" }, { sending: true })).toBe("review");
  });
});

describe("SetReceiptStatus", () => {
  it.each([
    [{ state: "local" as const }, {}, "On this phone, waiting to send", "On this phone", "◐"],
    [{ state: "local" as const }, { sending: true }, "Sending: the queue is sending and this set is waiting in it", "Sending…", "↑"],
    [{ state: "local" as const }, { held: true }, "Held on this phone for its own account", "Held for its account", "‖"],
    [{ state: "synced" as const }, {}, "Saved to the server", "Saved", "✓"],
  ])("announces %j %j as its own word and glyph", (receipt, opts, label, word, glyph) => {
    render(<SetReceiptStatus receipt={receipt} {...opts} />);
    const status = screen.getByRole("status", { name: `Set status: ${label}` });
    expect(status.textContent).toBe(`${glyph}${word}`);
    expect(screen.queryByRole("button", { name: /review sync status/i })).toBeNull();
  });

  it("can expose a historical receipt without a live status announcement", () => {
    render(<SetReceiptStatus receipt={{ state: "synced" }} announce={false} />);

    expect(screen.getByRole("note", { name: "Set status: Saved to the server" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("in a List row it is a quiet glyph whose word stays in the accessible name", () => {
    const { container } = render(
      <SetReceiptStatus receipt={{ state: "synced" }} announce={false} mark />,
    );
    expect(container.querySelector(".set-receipt-word")).toBeNull();
    expect(screen.getByRole("note", { name: "Set status: Saved to the server" }).textContent).toBe("✓Saved");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Saved");
  });

  it("opens receipt details from Needs review without wrapping another action", () => {
    const onReview = vi.fn();
    render(
      <div>
        <button type="button" aria-label="Correct set 3">Last set</button>
        <SetReceiptStatus
          receipt={{ state: "review", reason: "The server has not confirmed this write." }}
          onReview={onReview}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review sync status: The server has not confirmed this write." }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status", { name: "Set status: Needs review" })).toBeTruthy();
    const correction = screen.getByRole("button", { name: "Correct set 3" });
    const review = screen.getByRole("button", { name: /review sync status/i });
    expect(correction.contains(review)).toBe(false);
    expect(review.contains(correction)).toBe(false);
  });
});
