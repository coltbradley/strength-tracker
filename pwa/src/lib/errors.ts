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

export interface BugReport {
  message: string;
  /** Free-form key/value diagnostics shown on the Sentry issue. */
  diagnostics: Record<string, string | number | null>;
}

/**
 * Send a user-written bug report. Returns false when there is nowhere to send
 * it (no DSN configured), so the caller can say so rather than pretending.
 */
export function sendBugReport(report: BugReport): boolean {
  if (!sentry) return false;
  sentry.withScope((scope) => {
    scope.setContext("diagnostics", report.diagnostics);
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
