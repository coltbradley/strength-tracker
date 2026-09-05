import { useEffect, useState } from "react";
import { isAuthRetryableFetchError, type Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { claimCacheFor } from "../lib/db";
import { reportError } from "../lib/errors";
import { readPersistedSession } from "../lib/persistedSession";

export interface AuthState {
  loading: boolean;
  session: Session | null;
}

/** Point the device cache at this user, clearing it if it belonged to another. */
function claim(userId: string | null): void {
  claimCacheFor(userId).catch((e: unknown) =>
    reportError(e, "clear cache for signed-in user"),
  );
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    session: null,
  });

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getSession().then(({ data, error }) => {
      // A null session has two meanings and they are not the same. With no
      // error, nobody is signed in. With a RETRYABLE error, the token expired
      // and the refresh could not reach the server — which is the ordinary
      // state of opening the app in a gym with no signal, and showing Login
      // there locks someone out of their own workout over a network blip.
      // The stored session stands in until the refresh gets an answer;
      // auth-js keeps ticking and emits TOKEN_REFRESHED when it does.
      //
      // Identity only. Every request still carries the real token and is
      // still refused by the server if that token is no good.
      const session =
        data.session ??
        (error && isAuthRetryableFetchError(error)
          ? readPersistedSession()
          : null);
      if (!cancelled) setState({ loading: false, session });
      // Claimed here as well as in the listener below. supabase-js does emit
      // INITIAL_SESSION on subscribe, but the cache is read by screens the
      // moment they mount, so the claim must not depend on one event arriving.
      // It is idempotent: a no-op whenever the user has not changed.
      claim(session?.user?.id ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ loading: false, session });
      // The device cache belongs to exactly one person. Signing out used to
      // leave everything the app had cached — programs, sessions, sets,
      // training maxes, coach notes — readable in IndexedDB for whoever opened
      // it next, and a token expiring followed by a different sign-in did the
      // same with no sign-out in between. Claiming it on every transition
      // covers both, and is a no-op when the user has not changed.
      claim(session?.user?.id ?? null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
