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
  known: true,
  online: true,
  flush: vi.fn(),
}));

vi.mock("../hooks/useOutboxStatus", () => ({
  useOutboxStatus: () => h.status,
  useOutboxKnown: () => h.known,
}));
vi.mock("../hooks/useFabDrag", () => ({ useOnline: () => h.online }));
vi.mock("../lib/sync", () => ({ outbox: { flush: h.flush } }));
vi.mock("./OutboxSheet", () => ({
  OutboxSheet: () => <div role="dialog" aria-label="Queue" />,
}));

beforeEach(() => {
  h.status = { pending: 0, dead: 0, held: 0, state: "idle", lastError: null };
  h.known = true;
  h.online = true;
  h.flush.mockClear();
});
afterEach(() => cleanup());

describe("SyncStatus chip", () => {
  it("is a bare check when everything is synced, and opens the queue", () => {
    render(<SyncStatus />);
    const chip = screen.getByRole("button", { name: "Nothing waiting to send" });
    expect(chip.textContent).toBe("✓");
    expect(chip.className).toContain("sync-chip-ok");
    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
    expect(h.flush).not.toHaveBeenCalled();
  });

  it("shows ◐ On phone · N for waiting writes; a tap opens the queue AND sends", () => {
    h.status = { ...h.status, pending: 3 };
    render(<SyncStatus />);
    const chip = screen.getByRole("button", { name: /^On phone · 3/ });
    expect(chip.textContent).toBe("◐On phone · 3");
    // the compact (session header) rendering reads the count off the chip
    expect(chip.getAttribute("data-count")).toBe("3");
    fireEvent.click(chip);
    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
  });

  it("D2: offline, a tap on a waiting chip still answers by opening the queue, and does not pretend to send", () => {
    h.online = false;
    h.status = { ...h.status, pending: 1 };
    render(<SyncStatus />);
    const chip = screen.getByRole("button", { name: /^On phone · 1/ });
    expect(chip.getAttribute("aria-label")).toMatch(/offline/i);
    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
    expect(h.flush).not.toHaveBeenCalled();
  });

  it("D2: a sending chip opens the queue too", () => {
    h.status = { ...h.status, pending: 2, state: "syncing" };
    render(<SyncStatus />);
    fireEvent.click(screen.getByRole("button", { name: /^Sending · 2/ }));
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
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
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
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
      screen.queryByRole("button", { name: "Nothing waiting to send" }),
    ).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
  });

  it("M4: never claims the check before the queue has been read", () => {
    h.known = false;
    render(<SyncStatus />);
    expect(screen.queryByRole("button", { name: "Nothing waiting to send" })).toBeNull();
    const chip = screen.getByRole("button", { name: /Checking what is waiting/ });
    expect(chip.textContent).toBe("◌");
    expect(chip.className).toContain("sync-chip-unknown");
    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
  });

  it("M4: waiting writes are shown even while the status is still not known", () => {
    h.known = false;
    h.status = { ...h.status, pending: 2 };
    render(<SyncStatus />);
    expect(screen.getByRole("button", { name: /^On phone · 2/ })).toBeTruthy();
  });

  it("M4: an empty queue with a failed status refresh is not Held", () => {
    h.status = { ...h.status, pending: 0, held: 0, state: "error", lastError: "refresh failed" };
    render(<SyncStatus />);
    expect(screen.queryByRole("button", { name: /^Held/ })).toBeNull();
    const chip = screen.getByRole("button", { name: /^Retrying, retrying, tap to retry/ });
    expect(chip.textContent).toBe("◐Retrying");
    fireEvent.click(chip);
    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
  });

  it("D2: the all-synced chip says so offline without claiming a send", () => {
    h.online = false;
    render(<SyncStatus />);
    const chip = screen.getByRole("button", { name: /^Nothing waiting to send/ });
    expect(chip.getAttribute("aria-label")).toMatch(/offline/i);
    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Queue" })).toBeTruthy();
  });
});
