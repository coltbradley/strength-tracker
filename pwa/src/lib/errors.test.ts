// Two claims the bug reporter makes and must not break.
//
// 1. What the sheet shows is what gets sent. The sheet renders the array
//    buildBugDiagnostics returns and hands the SAME array to sendBugReport,
//    so pinning the rows here pins both halves at once.
// 2. It is saved durably before Sentry gets a best-effort mirror. A report
//    that only enters a third-party inbox is not a report we can rely on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sendBugReport now queues through the outbox rather than writing directly,
// so what is under test is the enqueue call, not a supabase insert — see the
// "sendBugReport" describe block below and the 2026-09-16 sync-noise fix.
const { enqueueMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
}));

const scope = {
  setContext: vi.fn(),
  setTag: vi.fn(),
};

vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({})),
  replayIntegration: vi.fn(() => ({})),
  setUser: vi.fn(),
  withScope: (fn: (s: typeof scope) => void) => fn(scope),
  captureFeedback: vi.fn(),
  captureException: vi.fn(),
}));

// Mocked rather than left real: sync.ts's real module pulls in currentUser.ts,
// which calls supabase.auth.getSession() at module-eval time, and this file
// has no reason to exercise that whole chain just to test a bug report queue.
vi.mock("./sync", () => ({
  outbox: { enqueue: enqueueMock },
}));

import * as Sentry from "@sentry/react";
import {
  buildBugDiagnostics,
  initSentry,
  onToast,
  resetSentryForTests,
  sendBugReport,
  type BugFacts,
  type Toast,
} from "./errors";

const FACTS: BugFacts = {
  build: "0.1.0+9f3a2b1",
  route: "/plan/1d0f8f0e-6d1c-4a1b-9f26-2f1a6c4b7e55",
  userId: "8ac2d761-4e07-4937-a595-68a456133db9",
  online: false,
  standalone: true,
  viewport: { w: 375, h: 812 },
  screen: { w: 390, h: 844, dpr: 3 },
  now: new Date(2026, 7, 30, 14, 32),
  timeZone: "America/Los_Angeles",
  unit: "lb",
  openedAt: new Date(2026, 7, 30, 12, 20).getTime(),
  session: {
    id: "c0ffee00-0000-4000-8000-000000000001",
    label: "Upper body",
    startedAt: new Date(2026, 7, 30, 13, 45).toISOString(),
  },
  queued: 3,
  dead: 1,
  syncState: "error",
  syncError: "Failed to fetch",
  recentErrors: "2026-08-30T21:31:02.000Z [log set] Failed to fetch",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)",
};

const valueOf = (label: string, facts: BugFacts = FACTS): string =>
  buildBugDiagnostics(facts).find((d) => d.label === label)?.value ?? "MISSING";

describe("buildBugDiagnostics", () => {
  it("says the same things in the same order every time", () => {
    expect(buildBugDiagnostics(FACTS).map((d) => d.label)).toEqual([
      "App version",
      "Screen you were on",
      "Workout in progress",
      "Connection",
      "Waiting to sync",
      "Weights shown in",
      "Screen size",
      "Device clock",
      "App open for",
      "Signed in as",
      "Recent errors",
      "Browser",
    ]);
  });

  it("names the screen but keeps the id that says WHICH day", () => {
    expect(valueOf("Screen you were on")).toBe(
      "Plan editor · /plan/1d0f8f0e-6d1c-4a1b-9f26-2f1a6c4b7e55",
    );
    expect(valueOf("Screen you were on", { ...FACTS, route: "/" })).toBe(
      "Today · /",
    );
    // an unmapped route is still reported, never dropped
    expect(valueOf("Screen you were on", { ...FACTS, route: "/nope" })).toBe(
      "/nope",
    );
  });

  it("ages the open session rather than quoting a timestamp", () => {
    expect(valueOf("Workout in progress")).toBe(
      "Upper body · started 47 min ago · c0ffee00-0000-4000-8000-000000000001",
    );
    expect(valueOf("Workout in progress", { ...FACTS, session: null })).toBe(
      "none",
    );
  });

  it("distinguishes an empty queue from a stuck one", () => {
    expect(valueOf("Waiting to sync")).toBe(
      "3 queued · 1 failed · error · last error: Failed to fetch",
    );
    expect(
      valueOf("Waiting to sync", {
        ...FACTS,
        queued: 0,
        dead: 0,
        syncState: "idle",
        syncError: null,
      }),
    ).toBe("nothing waiting · idle");
  });

  it("carries the device's own clock and zone", () => {
    // "wrong day" bugs are unanswerable without this: calendar days in this
    // app are the DEVICE's days.
    expect(valueOf("Device clock")).toBe(
      "30/08/2026, 14:32:00 · America/Los_Angeles",
    );
  });

  it("reads long uptimes in hours", () => {
    expect(valueOf("App open for")).toBe("2h 12m");
    expect(
      valueOf("App open for", { ...FACTS, openedAt: FACTS.now.getTime() }),
    ).toBe("0 min");
  });

  it("reports both the window and the device it sits in", () => {
    expect(valueOf("Screen size")).toBe("375×812 in 390×844 · 3x");
  });

  it("says signed out rather than nothing", () => {
    expect(valueOf("Signed in as", { ...FACTS, userId: null })).toBe(
      "signed out",
    );
  });
});

describe("sendBugReport", () => {
  beforeEach(() => {
    resetSentryForTests();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetSentryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("saves the report even when Sentry is not configured", async () => {
    const result = await sendBugReport({
      message: "it broke",
      diagnostics: [],
    });

    expect(result).toEqual({ ok: true });
    expect(enqueueMock).toHaveBeenCalledWith({
      kind: "insert",
      table: "feedback",
      payload: {
        id: expect.any(String),
        kind: "bug",
        title: "it broke",
        detail: "it broke",
        context: "",
        source: "user",
      },
    });
    expect(Sentry.captureFeedback).not.toHaveBeenCalled();
  });

  it("saves the shown diagnostics and mirrors a durable report to Sentry", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o0.ingest.sentry.io/1");
    await initSentry();

    const diagnostics = buildBugDiagnostics(FACTS);
    const result = await sendBugReport({
      message: "it did something weird",
      diagnostics,
    });

    expect(result).toEqual({ ok: true });
    expect(enqueueMock).toHaveBeenCalledWith({
      kind: "insert",
      table: "feedback",
      payload: {
        id: expect.any(String),
        kind: "bug",
        title: "it did something weird",
        detail: "it did something weird",
        context: diagnostics.map((d) => `${d.label}: ${d.value}`).join("\n"),
        source: "user",
      },
    });

    expect(Sentry.captureFeedback).toHaveBeenCalledWith({
      message: "it did something weird",
      source: "in-app-report",
    });
    expect(scope.setTag).toHaveBeenCalledWith("source", "in-app-report");
    // exactly the rows the sender read, keyed by the labels they read them by
    const [name, context] = scope.setContext.mock.calls[0] as [
      string,
      Record<string, string>,
    ];
    expect(name).toBe("diagnostics");
    expect(Object.keys(context)).toEqual(diagnostics.map((d) => d.label));
    expect(context["Waiting to sync"]).toBe(
      "3 queued · 1 failed · error · last error: Failed to fetch",
    );
  });

  // enqueue() only rejects when IndexedDB itself failed — there is no longer
  // a separate "the network request failed" shape to distinguish, because
  // the outbox absorbs that on its own and retries later.
  it("keeps the failure visible when the local write itself fails", async () => {
    enqueueMock.mockRejectedValue(new Error("indexeddb unavailable"));

    const result = await sendBugReport({
      message: "the plan would not save",
      diagnostics: [],
    });

    expect(result).toEqual({
      ok: false,
      message: "Couldn't save the report on this device. Try again.",
    });
    expect(Sentry.captureFeedback).not.toHaveBeenCalled();
  });

  // ReportBugSheet toasts `result.message` on a failure. If sendBugReport's
  // own error reporting also toasts, the sender sees two toasts for one
  // failure. The failure still has to be reported (console + Sentry via
  // reportError) — it just must not toast a second time on top of the
  // caller's.
  it("does not toast when the local write fails — the caller shows the one toast", async () => {
    enqueueMock.mockRejectedValue(new Error("indexeddb unavailable"));
    const seen: Toast[] = [];
    const stop = onToast((t) => seen.push(t));

    await sendBugReport({ message: "it broke again", diagnostics: [] });

    stop();
    expect(seen).toEqual([]);
  });
});
