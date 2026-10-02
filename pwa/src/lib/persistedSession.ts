// The session the auth library has on disk, for the one case where asking it
// politely does not work: the app opened with no network and an access token
// that expired since last time.
//
// `supabase.auth.getSession()` tries to refresh an expired token, and when the
// refresh cannot reach the server it returns `session: null` with a retryable
// error — the same shape as a genuine sign-out. Two callers read that null and
// drew the wrong conclusion. `useAuth` showed the Login screen, and
// `currentUser` reported "nobody", which holds every queued write. Both to
// someone standing in a basement gym who signed in perfectly well yesterday
// and whose refresh token is sitting right there, valid, in localStorage.
//
// THIS IS IDENTITY, NEVER AUTHORIZATION. It answers "whose data is this device
// holding" so the shell can render and the outbox can stamp an owner. Every
// actual request still carries the real token and is still refused by the
// server if that token is no good. Nothing here grants access to anything.
//
// It reads the auth library's private storage key, which is a coupling. It is
// deliberately loose about it — any `sb-*-auth-token`, any parse failure, any
// unexpected shape returns null — so the worst an SDK change can do is put us
// back on today's behaviour.

import type { Session } from "@supabase/supabase-js";

/** `sb-<project-ref>-auth-token`, plus the pre-2.x name. */
const KEY = /^(sb-.+-auth-token|supabase\.auth\.token)$/;

interface Stored {
  user?: { id?: unknown };
  access_token?: unknown;
  refresh_token?: unknown;
}

/**
 * The stored session, or null when there is none, storage is unreadable, or
 * what is there is not a session. Never throws: a private window, cleared site
 * data and a browser blocking storage all land on null.
 *
 * `store` is injectable for tests only; production always reads the real
 * localStorage, and reads it lazily so a context without one (a worker, a
 * thumbnail renderer) is a null rather than a module-load crash.
 */
export function readPersistedSession(
  store: Storage | undefined = globalThis.localStorage,
): Session | null {
  try {
    if (!store) return null;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null || !KEY.test(key)) continue;
      const raw = store.getItem(key);
      if (raw === null || raw.length === 0) continue;

      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) continue;
      const s = parsed as Stored;
      // A refresh token is what makes this recoverable rather than a relic; a
      // user id is what the callers actually need.
      if (typeof s.user?.id !== "string" || s.user.id.length === 0) continue;
      if (typeof s.refresh_token !== "string") continue;
      return parsed as Session;
    }
  } catch {
    // unreadable storage is the same as no session
  }
  return null;
}

/** The persisted user id, or null. */
export function readPersistedUserId(
  store: Storage | undefined = globalThis.localStorage,
): string | null {
  return readPersistedSession(store)?.user?.id ?? null;
}

/**
 * Whether the session on disk still carries an unexpired access token. After
 * a request has run this is the cheap, synchronous way to tell if it went out
 * as the user or, after a failed refresh, as the anon key (CORE-2). auth-js
 * saves a refreshed session to storage before the request is built, so a live
 * token here means the request was authenticated.
 *
 * Unknown answers "live": no storage, or a stored session without an expiry,
 * cannot prove the request was anonymous, and the caller only uses a false
 * here to refuse to cache an EMPTY answer. Bookkeeping, not authorization.
 */
export function storedSessionIsLive(
  store: Storage | undefined = globalThis.localStorage,
  nowMs: number = Date.now(),
): boolean {
  if (!store) return true;
  const s = readPersistedSession(store);
  if (!s) return false;
  const exp = (s as { expires_at?: unknown }).expires_at;
  return typeof exp !== "number" || exp * 1000 > nowMs;
}

/** How long a cold start waits for `getSession()` before it draws the shell
 *  from the stored session. A refresh that cannot reach the server retries
 *  for about 25 s inside auth-js, which is an eternity on a splash screen. */
export const BOOT_SESSION_WAIT_MS = 3000;
/** The same wait when the browser already says there is no network. */
export const BOOT_SESSION_WAIT_OFFLINE_MS = 250;

interface SessionResult {
  data: { session: Session | null };
  error: unknown;
}

/**
 * Resolve who is signed in at startup without waiting out a dead network
 * (NEW-CORE-1), and without mistaking "could not ask" for "nobody"
 * (CORE-1, CORE-12).
 *
 * `deliver(session, provisional)` is called once the answer is known. If
 * `getSession()` is still pending after a short wait (shorter when
 * `navigator.onLine` is false) and a session is on disk, that session is
 * delivered FIRST as provisional, for identity only. The real answer is
 * delivered when it arrives and always wins: a genuine sign-out reaches
 * `deliver(null, false)` and clears the shell; a retryable failure keeps the
 * stored session; a rejection falls back to it too. Returns a cancel function.
 */
export function resolveBootSession(
  getSession: () => Promise<SessionResult>,
  isRetryable: (e: unknown) => boolean,
  deliver: (session: Session | null, provisional: boolean) => void,
  onError?: (e: unknown) => void,
): () => void {
  let done = false;
  let cancelled = false;
  const offline =
    typeof navigator !== "undefined" && navigator.onLine === false;
  const timer = setTimeout(
    () => {
      if (done || cancelled) return;
      const stored = readPersistedSession();
      if (stored) deliver(stored, true);
    },
    offline ? BOOT_SESSION_WAIT_OFFLINE_MS : BOOT_SESSION_WAIT_MS,
  );
  getSession().then(
    ({ data, error }) => {
      done = true;
      clearTimeout(timer);
      if (cancelled) return;
      deliver(
        data.session ??
          (error && isRetryable(error) ? readPersistedSession() : null),
        false,
      );
    },
    (e: unknown) => {
      done = true;
      clearTimeout(timer);
      if (cancelled) return;
      // A rejection (storage lock timeout) is "we never found out", the same
      // as a retryable error: stand in the stored identity, never Login.
      onError?.(e);
      deliver(readPersistedSession(), false);
    },
  );
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
