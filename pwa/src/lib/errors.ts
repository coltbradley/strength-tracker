// Single error funnel: console + optional Sentry (VITE_SENTRY_DSN) + in-app
// toast. Never swallow; everything caught anywhere routes through reportError.

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
// whole integration is a no-op and the bundle never loads it.
let sentry: { captureException: (e: unknown) => unknown } | null = null;

export async function initSentry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  try {
    const Sentry = await import("@sentry/react");
    Sentry.init({ dsn });
    sentry = Sentry;
  } catch (e) {
    console.error("[errors] Sentry init failed", e);
  }
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
