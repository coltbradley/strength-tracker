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
// It reads the auth library's private storage key, which is a coupling. The
// key is exactly `sb-<project-ref>-auth-token` for THIS deployment's
// `VITE_SUPABASE_URL`. Scanning every `sb-*-auth-token` on the origin adopts
// another project's user, and the outbox then stamps that id onto writes the
// live token does not own. A missing or unreadable key returns null — the
// same answer as a genuine sign-out — rather than a guess.

import type { Session } from "@supabase/supabase-js";

/** First hostname label, the same slice supabase-js uses for its storage key. */
const PROJECT_REF = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface Stored {
  user?: { id?: unknown };
  access_token?: unknown;
  refresh_token?: unknown;
}

/** Project ref from a Supabase URL, or null when the URL is missing or not one. */
function projectRefFromSupabaseUrl(
  url: string | null | undefined,
): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    return normalizeProjectRef(new URL(url).hostname.split(".")[0] ?? "");
  } catch {
    return null;
  }
}

function normalizeProjectRef(ref: string | null): string | null {
  if (ref === null) return null;
  const normalized = ref.trim().toLowerCase();
  // The placeholder client in supabase.ts is not a project. Adopting
  // `sb-placeholder-auth-token` would stamp a key this deployment does not use.
  if (normalized.length === 0 || normalized === "placeholder") return null;
  return PROJECT_REF.test(normalized) ? normalized : null;
}

function configuredProjectRef(): string | null {
  return projectRefFromSupabaseUrl(import.meta.env.VITE_SUPABASE_URL);
}

/**
 * The stored session, or null when there is none, storage is unreadable, or
 * what is there is not a session. Never throws: a private window, cleared site
 * data and a browser blocking storage all land on null.
 *
 * `store` is injectable for tests only; production always reads the real
 * localStorage, and reads it lazily so a context without one (a worker, a
 * thumbnail renderer) is a null rather than a module-load crash.
 *
 * `projectRef` defaults to the configured Supabase project. Pass null to
 * fail closed when the caller already knows there is no project.
 */
export function readPersistedSession(
  store: Storage | undefined = globalThis.localStorage,
  projectRef?: string | null,
): Session | null {
  const ref = normalizeProjectRef(
    projectRef === undefined ? configuredProjectRef() : projectRef,
  );
  if (ref === null) return null;
  try {
    if (!store) return null;
    const raw = store.getItem(`sb-${ref}-auth-token`);
    if (raw === null || raw.length === 0) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const s = parsed as Stored;
    // A refresh token is what makes this recoverable rather than a relic; a
    // user id is what the callers actually need.
    if (typeof s.user?.id !== "string" || s.user.id.length === 0) return null;
    if (typeof s.refresh_token !== "string") return null;
    return parsed as Session;
  } catch {
    // unreadable storage is the same as no session
  }
  return null;
}

/** The persisted user id, or null. */
export function readPersistedUserId(
  store: Storage | undefined = globalThis.localStorage,
  projectRef?: string | null,
): string | null {
  return readPersistedSession(store, projectRef)?.user?.id ?? null;
}
