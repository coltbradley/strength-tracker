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
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw new Error(error.message);
      setSent(true);
    } catch (e) {
      reportError(e, "sign in");
    } finally {
      setBusy(false);
    }
  };

  // Fallback for installed iOS PWAs: the magic link opens in Safari, whose
  // storage is partitioned away from the installed app, so the session never
  // reaches the PWA. The same email carries a 6-digit code when the Supabase
  // email template includes {{ .Token }} — verifying it here signs in inside
  // the app itself.
  const verifyCode = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: code.trim(),
        type: "email",
      });
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
            Magic link sent to {email}. Open it on this device — or, if you’re
            in the installed app, enter the 6-digit code from the email:
          </p>
          <form
            className="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyCode();
            }}
          >
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || code.trim().length < 6}
            >
              {busy ? "Verifying…" : "Verify code"}
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
            {busy ? "Sending…" : "Send magic link"}
          </button>
        </form>
      )}
    </div>
  );
}
