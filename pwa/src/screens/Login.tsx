import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { reportError } from "../lib/errors";

export function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

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
        <p className="login-sent">
          Magic link sent to {email}. Open it on this device.
        </p>
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
