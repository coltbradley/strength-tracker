import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { reportError } from "../lib/errors";

export function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

  const send = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          // origin + base path so it works when hosted under a subpath
          emailRedirectTo: window.location.origin + import.meta.env.BASE_URL,
        },
      });
      if (error) throw new Error(error.message);
      setSent(true);
    } catch (e) {
      reportError(e, "sign in");
    } finally {
      setBusy(false);
    }
  };

  // The code IS the sign-in path, not a fallback: supabase/config.toml ships a
  // code-only email template ({{ .Token }}, no link) because a link is useless
  // to an installed iOS PWA — it opens in Safari, whose storage is partitioned
  // away from the app, so the session never reaches it. The copy on this
  // screen must never promise a link; it used to, and the email has not
  // contained one since the custom template landed.
  //
  // Pasting a magic link is still accepted here, silently and undocumented, so
  // that a link-bearing email (the stock template, a project that has not run
  // scripts/push-auth-config.sh) is not a dead end. Its `token` query param is
  // a token hash verifyOtp takes. Not advertised: offering two ways to sign in
  // is what made this screen confusing.
  const verifyCode = async () => {
    setBusy(true);
    try {
      const raw = code.trim();
      let error;
      if (/^\d{6}$/.test(raw)) {
        ({ error } = await supabase.auth.verifyOtp({
          email,
          token: raw,
          type: "email",
        }));
      } else {
        let tokenHash = "";
        try {
          tokenHash = new URL(raw).searchParams.get("token") ?? "";
        } catch {
          // not a URL; fall through to the error below
        }
        if (!tokenHash)
          throw new Error("That does not look like the 6-digit code from the email");
        ({ error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: "email",
        }));
      }
      if (error) throw new Error(error.message);
      // success: onAuthStateChange in useAuth re-renders the app
    } catch (e) {
      reportError(e, "verify code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <h1 className="login-title">Strength Log</h1>
      {!supabaseConfigured && (
        <div className="warn-badge">
          Supabase env vars missing — set VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY
        </div>
      )}
      {sent ? (
        <div className="login-form">
          <p className="login-sent">
            We sent a 6-digit code to {email}. Check your email and type the
            code in below.
          </p>
          <form
            className="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyCode();
            }}
          >
            <div className="field-label">6-DIGIT CODE</div>
            <input
              className="input"
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <div className="microcopy">
              The email contains a code, not a link. It expires in an hour; if
              it does, use a different email below to send a new one.
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || code.trim().length < 6}
            >
              {busy ? "Verifying…" : "Sign in"}
            </button>
          </form>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setSent(false);
              setCode("");
            }}
          >
            Use a different email
          </button>
        </div>
      ) : (
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="field-label">EMAIL</div>
          <input
            className="input"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || email.length === 0}
          >
            {busy ? "Sending…" : "Email me a code"}
          </button>
        </form>
      )}
    </div>
  );
}
