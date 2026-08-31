// Single error funnel: console + optional Sentry (VITE_SENTRY_DSN) + in-app
// toast. Never swallow; everything caught anywhere routes through reportError.
import { buildStamp } from "./build";


type ToastKind = "error" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

type ToastListener = (toast: Toast) => void;

const toastListeners = new Set<ToastListener>();
let toastId = 0;

export function onToast(fn: ToastListener): () => void {
  toastListeners.add(fn);
  return () => toastListeners.delete(fn);
}

export function toast(message: string, kind: ToastKind = "info"): void {
  const t = { id: ++toastId, kind, message };
  for (const fn of toastListeners) fn(t);
}

// Sentry is loaded lazily and only when a DSN is configured; without one the
// whole integration is a no-op and the bundle never loads it. The DSN is not a
// secret (it ships in the client bundle by design and is write-only), but it
// stays an env var so a local dev run reports nothing.
type SentryApi = typeof import("@sentry/react");
let sentry: SentryApi | null = null;

/** Whoever is signed in, so an event says which log it came from. */
let pendingUserId: string | null = null;

// The last few errors, kept so a bug report can carry what actually blew up.
// A person writing "it did something weird" cannot quote a stack trace; the
// app can. Capped, and never persisted — this is one session's tail.
const RECENT_CAP = 5;
const recentErrors: { at: string; context: string; message: string }[] = [];

export function recentErrorLog(): string {
  if (recentErrors.length === 0) return "none";
  return recentErrors
    .map((e) => `${e.at} [${e.context}] ${e.message}`)
    .join("\n");
}

export async function initSentry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  try {
    const Sentry = await import("@sentry/react");
    Sentry.init({
      dsn,
      release: buildStamp(),
      environment: import.meta.env.DEV ? "development" : "production",
      integrations: [
        Sentry.browserTracingIntegration(),
        // Replay is why this is here: the tester is not technical and cannot
        // describe what she tapped. maskAllText/blockAllMedia are the SDK
        // defaults and stay on — a replay should show the shape of the
        // interaction, not read back someone's training log.
        Sentry.replayIntegration(),
      ],
      // Two people on one app. Sampling exists to control cost at volume and
      // there is no volume here; full traces are worth more than the pennies.
      tracesSampleRate: 1.0,
      // Propagate trace headers to our own API only. A wildcard would attach
      // them to every cross-origin request the app makes.
      tracePropagationTargets: [
        "localhost",
        import.meta.env.VITE_SUPABASE_URL ?? "",
      ].filter(Boolean),
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
    });
    sentry = Sentry;
    if (pendingUserId !== null) Sentry.setUser({ id: pendingUserId });
  } catch (e) {
    console.error("[errors] Sentry init failed", e);
  }
}

/**
 * Tag events with the signed-in user id. Called on every auth transition, and
 * buffered when Sentry has not finished loading yet (init is lazy). Sign-out
 * passes null, which clears it — the next person on this device is not the
 * last one.
 */
export function setSentryUser(userId: string | null): void {
  pendingUserId = userId;
  sentry?.setUser(userId === null ? null : { id: userId });
}

/**
 * When this tab loaded. A report twenty seconds after a cold start and one
 * from a PWA left open for three days are different animals — the second is
 * where stale caches and expired tokens live.
 */
const OPENED_AT = Date.now();

export function appOpenedAt(): number {
  return OPENED_AT;
}

/** One labelled line of a bug report, worded for the person sending it. */
export interface BugDiagnostic {
  label: string;
  value: string;
}

/**
 * What the app knows about itself at the moment someone hits report.
 *
 * Passed in rather than read off `window` in here, so the formatting below is
 * pure and testable, and so the list in the sheet and the payload cannot
 * drift apart: both come from one call to buildBugDiagnostics.
 */
export interface BugFacts {
  build: string;
  route: string;
  userId: string | null;
  online: boolean;
  standalone: boolean;
  viewport: { w: number; h: number };
  screen: { w: number; h: number; dpr: number };
  now: Date;
  /** IANA zone. A "my workout is on the wrong day" report is unanswerable
   *  without it — calendar days in this app are the DEVICE's days. */
  timeZone: string;
  unit: string;
  openedAt: number;
  /** The session running right now, if there is one. */
  session: { id: string; label: string | null; startedAt: string } | null;
  queued: number;
  dead: number;
  syncState: string;
  syncError: string | null;
  recentErrors: string;
  userAgent: string;
}

const ROUTE_NAMES: Record<string, string> = {
  "/": "Today",
  "/session": "Session",
  "/history": "History",
  "/end": "Finishing a session",
};

/** Route as a place the sender recognises, with the raw path kept: the id in
 *  `/plan/<uuid>` is the only pointer to WHICH day they were editing. */
function routeLabel(route: string): string {
  if (route.startsWith("/plan/")) return `Plan editor · ${route}`;
  const name = ROUTE_NAMES[route];
  return name === undefined ? route : `${name} · ${route}`;
}

/** "12 min" / "3h 05m" — durations a reader holds in their head. */
function duration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/**
 * The report as a list a non-technical person can read before sending it.
 *
 * Ordered by what the SENDER recognises — where they were, what they were
 * doing — before what a debugger wants. Every row is rendered in the sheet
 * and every row is sent, because the payload is literally this array: there
 * is no second place for a field to be attached from unseen.
 */
export function buildBugDiagnostics(f: BugFacts): BugDiagnostic[] {
  return [
    { label: "App version", value: f.build },
    { label: "Screen you were on", value: routeLabel(f.route) },
    {
      label: "Workout in progress",
      value:
        f.session === null
          ? "none"
          : [
              f.session.label ?? "unnamed workout",
              `started ${duration(
                f.now.getTime() - new Date(f.session.startedAt).getTime(),
              )} ago`,
              f.session.id,
            ].join(" · "),
    },
    {
      label: "Connection",
      value: `${f.online ? "online" : "offline"} · ${
        f.standalone ? "installed to the home screen" : "in a browser tab"
      }`,
    },
    {
      // The single most useful line here: "my sets vanished" and "my sets are
      // sitting in the outbox" look identical from the couch. Depth, state and
      // the last failure are one row because they are one question.
      label: "Waiting to sync",
      value: [
        f.queued === 0 && f.dead === 0
          ? "nothing waiting"
          : `${f.queued} queued · ${f.dead} failed`,
        f.syncState,
        ...(f.syncError === null ? [] : [`last error: ${f.syncError}`]),
      ].join(" · "),
    },
    { label: "Weights shown in", value: f.unit },
    {
      // Both sizes, because a layout complaint is about the window and a
      // "everything is tiny" one is about the device.
      label: "Screen size",
      value: `${f.viewport.w}×${f.viewport.h} in ${f.screen.w}×${f.screen.h} · ${f.screen.dpr}x`,
    },
    {
      label: "Device clock",
      value: `${f.now.toLocaleString("en-GB")} · ${f.timeZone}`,
    },
    { label: "App open for", value: duration(f.now.getTime() - f.openedAt) },
    { label: "Signed in as", value: f.userId ?? "signed out" },
    { label: "Recent errors", value: f.recentErrors },
    { label: "Browser", value: f.userAgent },
  ];
}

export interface BugReport {
  message: string;
  /** Exactly the rows the sender was shown. */
  diagnostics: BugDiagnostic[];
}

/**
 * Send a user-written bug report. Returns false when there is nowhere to send
 * it (no DSN configured), so the caller can say so rather than pretending.
 *
 * It goes as Sentry USER FEEDBACK (`type: 'feedback'`), not an exception: the
 * point is a person asking for help, and the feedback inbox is where a person
 * gets answered. The diagnostics ride along as event context.
 */
export function sendBugReport(report: BugReport): boolean {
  if (!sentry) return false;
  sentry.withScope((scope) => {
    scope.setContext(
      "diagnostics",
      Object.fromEntries(report.diagnostics.map((d) => [d.label, d.value])),
    );
    scope.setTag("source", "in-app-report");
    sentry?.captureFeedback({
      message: report.message,
      source: "in-app-report",
    });
  });
  return true;
}

export function reportError(err: unknown, context?: string): void {
  const prefix = context ? `[${context}]` : "[error]";
  console.error(prefix, err);
  try {
    sentry?.captureException(err);
  } catch {
    // never let error reporting throw
  }
  const message = err instanceof Error ? err.message : String(err);
  recentErrors.push({
    at: new Date().toISOString(),
    context: context ?? "error",
    message,
  });
  if (recentErrors.length > RECENT_CAP) recentErrors.shift();
  toast(context ? `${context}: ${message}` : message, "error");
}

export function installGlobalHandlers(): void {
  window.addEventListener("error", (e) => {
    reportError(e.error ?? e.message, "uncaught");
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportError(e.reason, "unhandled rejection");
  });
}
