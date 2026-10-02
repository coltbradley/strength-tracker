import { useEffect, useState } from "react";
import { isAuthRetryableFetchError, type Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { claimCacheFor } from "../lib/db";
import { reportError } from "../lib/errors";
import { resolveBootSession } from "../lib/persistedSession";

export interface AuthState {
  loading: boolean;
  session: Session | null;
}

/** Point the device cache at this user, clearing it if it belonged to another.
 *  Resolves when the claim has SETTLED (claims are serialized in db.ts), so a
 *  caller can hold the UI back until the old owner's data is gone (CORE-4). */
function claim(userId: string | null): Promise<void> {
  return claimCacheFor(userId).then(
    () => undefined,
    (e: unknown) => reportError(e, "clear cache for signed-in user"),
  );
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    session: null,
  });

  useEffect(() => {
    let cancelled = false;
    // Claim first, render after. The Shell mounts keyed by user and reads the
    // cache at once; setting state before the claim finished let a new user's
    // screens read the previous user's cached data (CORE-4). Claims are
    // serialized and each settle chains on its own, so state is applied in
    // the order the answers arrived.
    const settle = (session: Session | null) => {
      void claim(session?.user?.id ?? null).then(() => {
        if (!cancelled) setState({ loading: false, session });
      });
    };

    // The cold-start answer lives here, not in the listener below.
    //
    // A null session has two meanings and they are not the same. With no
    // error, nobody is signed in. With a RETRYABLE error, the token expired
    // and the refresh could not reach the server — which is the ordinary
    // state of opening the app in a gym with no signal, and showing Login
    // there locks someone out of their own workout over a network blip.
    // The stored session stands in until the refresh gets an answer;
    // auth-js keeps ticking and emits TOKEN_REFRESHED when it does. And it
    // does not wait the ~25 s that refresh spends retrying: after a short
    // wait the stored session is drawn first (NEW-CORE-1).
    //
    // Identity only. Every request still carries the real token and is
    // still refused by the server if that token is no good.
    //
    // Claimed on every answer as well as in the listener. supabase-js does
    // emit INITIAL_SESSION on subscribe, but the cache is read by screens the
    // moment they mount, so the claim must not depend on one event arriving.
    // It is idempotent: a no-op whenever the user has not changed.
    const cancelBoot = resolveBootSession(
      () => supabase.auth.getSession(),
      isAuthRetryableFetchError,
      (session) => settle(session),
      (e) => reportError(e, "read the stored session"),
    );
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // auth-js emits INITIAL_SESSION(null) when its own getSession() ERRORED
      // (a refresh that could not reach the server), not only when nobody is
      // signed in. Acting on that null showed the Login screen and wiped the
      // device cache on every offline cold start (CORE-1). The boot answer
      // above sees the error and knows which kind of null it is, so it owns
      // the cold-start null; a real sign-out arrives as SIGNED_OUT.
      if (event === "INITIAL_SESSION" && session === null) return;
      // The device cache belongs to exactly one person. Signing out used to
      // leave everything the app had cached — programs, sessions, sets,
      // training maxes, coach notes — readable in IndexedDB for whoever opened
      // it next, and a token expiring followed by a different sign-in did the
      // same with no sign-out in between. Claiming it on every transition
      // covers both, and is a no-op when the user has not changed.
      settle(session);
    });
    return () => {
      cancelled = true;
      cancelBoot();
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
