// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SyncStatus } from "./SyncStatus";

const h = vi.hoisted(() => ({
  status: {
    pending: 0,
    dead: 0,
    held: 0,
    state: "idle" as "idle" | "syncing" | "error",
    lastError: null as string | null,
  },
  flush: vi.fn(),
}));

vi.mock("../hooks/useOutboxStatus", () => ({
  useOutboxStatus: () => h.status,
}));
vi.mock("../lib/sync", () => ({ outbox: { flush: h.flush } }));
vi.mock("./OutboxSheet", () => ({
  OutboxSheet: () => <div role="dialog" aria-label="Queue" />,
}));

beforeEach(() => {
  h.status = { pending: 0, dead: 0, held: 0, state: "idle", lastError: null };
  h.flush.mockClear();
});
afterEach(() => cleanup());

describe("SyncStatus chip", () => {
  it("is a bare check when everything is synced, and opens the queue", () => {
    render(<SyncStatus />);
    const chip = screen.getByRole("button", { name: "All sets on the server" });
    expect(chip.textContent).toBe("✓");
    expect(chip.className).toContain("sync-chip-ok");
    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
    expect(h.flush).not.toHaveBeenCalled();
  });

  it("shows ◐ On phone · N for waiting writes and flushes on tap", () => {
    h.status = { ...h.status, pending: 3 };
    render(<SyncStatus />);
    const chip = screen.getByRole("button", { name: /^On phone · 3/ });
    expect(chip.textContent).toBe("◐On phone · 3");
    fireEvent.click(chip);
    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows ↑ Sending · N while a flush is running", () => {
    h.status = { ...h.status, pending: 2, state: "syncing" };
    render(<SyncStatus />);
    expect(
      screen.getByRole("button", { name: /^Sending · 2/ }).textContent,
    ).toBe("↑Sending · 2");
  });

  it("keeps a retryable failure neutral: On phone, tap retries", () => {
    h.status = { ...h.status, pending: 1, state: "error" };
    render(<SyncStatus />);
    const chip = screen.getByRole("button", { name: /^On phone · 1, retrying/ });
    expect(chip.className).not.toContain("dead");
    fireEvent.click(chip);
    expect(h.flush).toHaveBeenCalledTimes(1);
  });

  it("shows ‖ Held and opens the queue instead of flushing", () => {
    h.status = { ...h.status, pending: 2, held: 2 };
    render(<SyncStatus />);
    const chip = screen.getByRole("button", { name: /^Held/ });
    expect(chip.textContent).toBe("‖Held");
    fireEvent.click(chip);
    expect(h.flush).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
  });

  it("shows a filled ! Review chip for dead writes, with no check beside it", () => {
    h.status = { ...h.status, dead: 1 };
    render(<SyncStatus />);
    const chip = screen.getByRole("button", { name: "Review 1 failed writes" });
    expect(chip.textContent).toBe("!Review");
    expect(chip.className).toContain("sync-chip-dead");
    expect(
      screen.queryByRole("button", { name: "All sets on the server" }),
    ).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
  });
});
