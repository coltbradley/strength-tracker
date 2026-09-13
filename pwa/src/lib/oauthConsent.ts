// The consent step of MCP sign-in. Supabase Auth redirects a lifter here with
// `?authorization_id=…` when ChatGPT or claude.ai asks for access; this page
// shows who is asking and where they will be sent, and approves or denies.

const CONSENT_SUFFIX = "oauth/consent";

export function isConsentPath(pathname: string, base: string): boolean {
  const root = base.endsWith("/") ? base : `${base}/`;
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === `${root}${CONSENT_SUFFIX}`;
}

/** Authorization ids are opaque tokens; anything with a separator in it did
 *  not come from Supabase and is not worth sending back to it. */
export function authorizationIdFrom(search: string): string | null {
  const id = new URLSearchParams(search).get("authorization_id");
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/** The part a person can check at a glance. A full redirect URI is noise; the
 *  host is what tells "chatgpt.com" apart from a lookalike. */
export function redirectHost(uri: string): string | null {
  try {
    return new URL(uri).hostname || null;
  } catch {
    return null;
  }
}
