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

  // Fallback for installed iOS PWAs: the magic link opens in Safari, whose
  // storage is partitioned away from the installed app, so the session never
  // reaches the PWA. Two in-app paths work instead:
  //   * the 6-digit code, when the Supabase email template includes
  //     {{ .Token }} (needs custom SMTP on free tier), or
  //   * pasting the magic link itself — its `token` query param is a token
  //     hash that verifyOtp accepts, so long-press > Copy Link in Mail and
  //     paste here. Works with the stock email template.
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
        if (!tokenHash) throw new Error("Paste the full link from the email");
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
            Magic link sent to {email}. Tap it in your email and you’re in.
          </p>
          <form
            className="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyCode();
            }}
          >
            <div className="field-label">CODE OR PASTED LINK</div>
            <input
              className="input"
              autoComplete="one-time-code"
              placeholder="6-digit code or pasted link"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <div className="microcopy">
              Installed app: the link opens in Safari instead — enter the
              6-digit code from the email, or long-press the link, Copy Link,
              and paste it here.
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
            {busy ? "Sending…" : "Send magic link"}
          </button>
        </form>
      )}
    </div>
  );
}
