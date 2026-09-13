import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { reportError } from "../lib/errors";
import { authorizationIdFrom, redirectHost } from "../lib/oauthConsent";

type Details = {
  authorization_id: string;
  redirect_uri: string;
  client: { name: string };
};

type State =
  | { kind: "loading" }
  | { kind: "ask"; details: Details }
  | { kind: "working" }
  | { kind: "expired" };

/**
 * Where Supabase Auth sends a lifter when an MCP client (ChatGPT, claude.ai)
 * asks for access. Rendered by App in place of the shell, after sign-in, so a
 * lifter who arrives signed out meets the normal Login screen first and lands
 * back here with the same URL.
 *
 * The page names the client AND the host it will redirect to, because dynamic
 * client registration lets anyone register any name: the host is the part a
 * lookalike cannot fake.
 */
export function OAuthConsent({ email }: { email: string | null }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const authorizationId = authorizationIdFrom(window.location.search);

  useEffect(() => {
    if (!authorizationId) {
      setState({ kind: "expired" });
      return;
    }
    // The demo mock (src/dev/mockSupabase.ts) has no OAuth 2.1 server surface
    // at all — `auth` there is a plain object with no `oauth` key — so this
    // page is unreachable in the demo build except by direct navigation.
    // Rather than throw on a missing method, treat it the same as an expired
    // request.
    if (typeof supabase.auth.oauth?.getAuthorizationDetails !== "function") {
      setState({ kind: "expired" });
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } =
        await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (cancelled) return;
      if (error || !data) {
        if (error) reportError(error, "oauth.getAuthorizationDetails");
        setState({ kind: "expired" });
        return;
      }
      if ("redirect_url" in data) {
        window.location.assign(data.redirect_url);
        return;
      }
      setState({ kind: "ask", details: data });
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizationId]);

  const decide = async (approve: boolean) => {
    if (!authorizationId) return;
    setState({ kind: "working" });
    const call = approve
      ? supabase.auth.oauth.approveAuthorization
      : supabase.auth.oauth.denyAuthorization;
    const { data, error } = await call.call(
      supabase.auth.oauth,
      authorizationId,
      {
        skipBrowserRedirect: true,
      },
    );
    if (error || !data) {
      if (error) reportError(error, approve ? "oauth.approve" : "oauth.deny");
      setState({ kind: "expired" });
      return;
    }
    window.location.assign(data.redirect_url);
  };

  if (state.kind === "expired") {
    return (
      <main className="oauth-consent">
        <h1 className="oauth-consent-title">
          This sign-in request has expired
        </h1>
        <p className="microcopy">
          Go back to the app that sent you here and connect again.
        </p>
      </main>
    );
  }

  if (state.kind !== "ask") {
    return (
      <main className="oauth-consent">
        <p className="microcopy">Checking the request…</p>
      </main>
    );
  }

  const { details } = state;
  const host = redirectHost(details.redirect_uri);

  return (
    <main className="oauth-consent">
      <div className="field-label">CONNECT AN APP</div>
      <h1 className="oauth-consent-title">
        {details.client.name} wants to use your Strength Log
      </h1>
      <p className="oauth-consent-body">
        It will read your training history and can write plans, goals, training
        maxes and notes. It can never change a logged set.
      </p>
      <p className="microcopy">
        Signed in as {email ?? "this account"}. After you choose, you go back to{" "}
        <strong>{host ?? "the app"}</strong>.
      </p>
      <div className="oauth-consent-actions">
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => void decide(true)}
        >
          Allow
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => void decide(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => void supabase.auth.signOut({ scope: "local" })}
        >
          Not you? Sign out
        </button>
      </div>
    </main>
  );
}
