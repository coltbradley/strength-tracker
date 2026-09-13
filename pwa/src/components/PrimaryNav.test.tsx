// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { App } from "../App";

const h = vi.hoisted(() => ({
  auth: {
    loading: false,
    session: { user: { id: "member-1" } },
  },
  status: {
    pending: 0,
    dead: 0,
    held: 0,
    state: "idle" as "idle" | "syncing" | "error",
    lastError: null as string | null,
  },
  getCoachAccess: vi.fn(async () => ({ enabled: true, reason: null })),
}));

vi.mock("../hooks/useAuth", () => ({ useAuth: () => h.auth }));
vi.mock("../hooks/useOutboxStatus", () => ({
  useOutboxStatus: () => h.status,
}));
vi.mock("../hooks/useFabDrag", () => ({
  useOnline: () => true,
}));
vi.mock("../lib/coachAccess", () => ({
  getCoachAccess: h.getCoachAccess,
}));
vi.mock("../lib/errors", () => ({
  reportError: vi.fn(),
  setSentryUser: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../lib/sync", () => ({
  outbox: { flush: vi.fn() },
}));

vi.mock("../screens/Login", () => ({ Login: () => <div>Login screen</div> }));
vi.mock("../screens/Today", () => ({
  Today: ({ presentation = "program" }: { presentation?: string }) => (
    <div data-testid="today" data-presentation={presentation}>
      Today presentation: {presentation}
    </div>
  ),
}));
vi.mock("../screens/Session", () => ({
  Session: () => <div>Session screen</div>,
}));
vi.mock("../screens/History", () => ({
  History: () => <div>Record screen</div>,
}));
vi.mock("../screens/End", () => ({ End: () => <div>End screen</div> }));
vi.mock("../screens/Plan", () => ({ Plan: () => <div>Plan screen</div> }));
vi.mock("./SettingsSheet", () => ({
  SettingsSheet: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Settings" /> : null,
}));
vi.mock("./OutboxSheet", () => ({ OutboxSheet: () => null }));
vi.mock("./Toasts", () => ({ Toasts: () => null }));
vi.mock("./CoachSheet", () => ({
  CoachSheet: () => <div role="dialog" aria-label="Coach" />,
}));
vi.mock("./ReportBugSheet", () => ({
  ReportBugSheet: () => <div role="dialog" aria-label="Report a problem" />,
}));

afterEach(() => cleanup());

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  h.auth = { loading: false, session: { user: { id: "member-1" } } };
  h.status = {
    pending: 0,
    dead: 0,
    held: 0,
    state: "idle",
    lastError: null,
  };
  document.body.classList.remove("focus-chrome-hidden");
});

describe("primary navigation", () => {
  it("links Train, Program, and Record to their routes", () => {
    render(<App />);

    const nav = screen.getByRole("navigation", {
      name: "Primary navigation",
    });
    expect(
      within(nav).getByRole("link", { name: "Train" }).getAttribute("href"),
    ).toBe("/");
    expect(
      within(nav).getByRole("link", { name: "Program" }).getAttribute("href"),
    ).toBe("/program");
    expect(
      within(nav).getByRole("link", { name: "Record" }).getAttribute("href"),
    ).toBe("/history");
    expect(screen.getByRole("button", { name: "go to Train" }).textContent).toBe("SET");
  });

  it("keeps Today's planning presentation available on Train and Program", async () => {
    render(<App />);

    expect(
      screen.getByTestId("today").getAttribute("data-presentation"),
    ).toBe("train");
    fireEvent.click(screen.getByRole("link", { name: "Program" }));
    await waitFor(() => {
      expect(
        screen.getByTestId("today").getAttribute("data-presentation"),
      ).toBe("program");
    });

    fireEvent.click(screen.getByRole("link", { name: "Record" }));
    expect(screen.getByText("Record screen")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Train" }));
    await waitFor(() => {
      expect(
        screen.getByTestId("today").getAttribute("data-presentation"),
      ).toBe("train");
    });
  });

  it("hides healthy sync while keeping queued and failed writes visible", () => {
    const view = render(<App />);
    expect(screen.queryByText("SYNCED")).toBeNull();

    h.status = { ...h.status, pending: 2, state: "idle" };
    view.rerender(<App />);
    expect(screen.getByRole("button", { name: "2 QUEUED" })).toBeTruthy();

    h.status = { ...h.status, pending: 2, state: "syncing" };
    view.rerender(<App />);
    expect(screen.getByRole("button", { name: "SYNCING 2…" })).toBeTruthy();

    h.status = { ...h.status, pending: 1, dead: 1, state: "error" };
    view.rerender(<App />);
    expect(
      screen.getByRole("button", { name: "review 1 failed writes" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 STUCK · RETRY" })).toBeTruthy();
  });

  it("keeps Coach, problem reporting, and Settings in the header with their sheets", async () => {
    render(<App />);

    const topbar = document.querySelector(".topbar");
    expect(topbar).not.toBeNull();
    const header = within(topbar as HTMLElement);
    fireEvent.click(header.getByRole("button", { name: /ask the coach/ }));
    expect(await screen.findByRole("dialog", { name: "Coach" })).toBeTruthy();

    cleanup();
    render(<App />);
    const reportHeader = within(document.querySelector(".topbar") as HTMLElement);
    fireEvent.click(reportHeader.getByRole("button", { name: /report a problem/ }));
    expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeTruthy();

    cleanup();
    render(<App />);
    fireEvent.click(within(document.querySelector(".topbar") as HTMLElement).getByRole("button", { name: "settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("keeps support and recovery access available during a focus session", () => {
    window.history.replaceState({}, "", "/session");
    document.body.classList.add("focus-chrome-hidden");
    h.status = { ...h.status, pending: 1, dead: 1, state: "error" };
    render(<App />);

    expect(screen.getByText("Session screen")).toBeTruthy();
    expect(document.body.classList.contains("focus-chrome-hidden")).toBe(true);

    const tools = screen.getByRole("group", { name: "Support and recovery" });
    expect(
      within(tools).getByRole("button", { name: "ask the coach" }),
    ).toBeTruthy();
    expect(
      within(tools).getByRole("button", { name: "report a problem" }),
    ).toBeTruthy();
    expect(
      within(tools).getByRole("button", { name: "settings" }),
    ).toBeTruthy();
    expect(
      within(tools).getByRole("button", { name: "review 1 failed writes" }),
    ).toBeTruthy();
    expect(
      within(tools).getByRole("button", { name: "1 STUCK · RETRY" }),
    ).toBeTruthy();
  });
});
