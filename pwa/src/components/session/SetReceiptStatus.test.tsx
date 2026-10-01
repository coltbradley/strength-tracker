// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetReceiptStatus } from "./SetReceiptStatus";


afterEach(cleanup);

describe("SetReceiptStatus", () => {
  it.each([
    [{ state: "local" as const }, "On this phone"],
    [{ state: "synced" as const }, "Synced"],
  ])("announces healthy receipt state as %s", (receipt, label) => {
    render(<SetReceiptStatus receipt={receipt} />);
    expect(screen.getByRole("status", { name: `Set status: ${label}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /review sync status/i })).toBeNull();
  });

  it("opens receipt details from Review without wrapping another action", () => {
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
    expect(screen.getByRole("button", { name: "Correct set 3" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Set status: Review" })).toBeTruthy();
    const correction = screen.getByRole("button", { name: "Correct set 3" });
    const review = screen.getByRole("button", { name: /review sync status/i });
    expect(correction.contains(review)).toBe(false);
    expect(review.contains(correction)).toBe(false);
  });
});
