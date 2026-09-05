import { useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { reportError, toast } from "../lib/errors";

/**
 * How long Resend stays quiet after a code goes out.
 *
 * Supabase rate-limits OTP sends per address, and a burst is answered with an
 * error rather than another email — so an unguarded Resend under an impatient
 * thumb produces a screenful of failures and no code at all. Thirty seconds is
 * longer than the email takes to arrive (waiting for it is the actual reason
 * anyone reaches for Resend) and short enough that sitting it out is not the
 * second dead end this whole change exists to remove.
 */
const RESEND_COOLDOWN_MS = 30_000;

/**
 * Whole seconds left on the cooldown. Pure, so the countdown can be tested
 * without a clock, and `ceil` rather than `round` so the label never reads
 * "0s" on a button that is still disabled.
 */
export function cooldownSeconds(until: number, now: number): number {
  return until <= now ? 0 : Math.ceil((until - now) / 1000);
}

export function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  // When Resend wakes up, and the clock the countdown is rendered against.
  // The remaining time is DERIVED from the two rather than counted down, so a
  // phone that slept through a few ticks still shows the right number.
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const waitSeconds = cooldownSeconds(resendAt, now);

  useEffect(() => {
    if (resendAt <= Date.now()) return;
    // Twice a second: a 1000ms tick drifts against the deadline and leaves the
    // button reading "1s" for the best part of two.
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= resendAt) window.clearInterval(id);
    }, 500);
    return () => window.clearInterval(id);
  }, [resendAt]);

  /** `resend` only changes what is SAID about the send — same request either
   *  way, because re-requesting a code for an address already on screen is the
   *  same call as requesting the first one. */
  const send = async (resend = false) => {
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
      // Whatever is in the box was typed from an email that has just been
      // superseded; leaving it there invites one more failed verify.
      if (resend) {
        setCode("");
        toast("New code sent. Use the newest email.");
      }
      const t = Date.now();
      setNow(t);
      // The cooldown starts on the FIRST send too. Resend appears already
      // counting down, which is both true and the clearest way to say that
      // hammering it is not the fix.
      setResendAt(t + RESEND_COOLDOWN_MS);
    } catch (e) {
      reportError(e, resend ? "resend code" : "sign in");
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
          throw new Error(
            "That does not look like the 6-digit code from the email",
          );
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
              The email contains a code, not a link. It expires in an hour. If
              it has expired, or it never arrived, send a new one.
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || code.trim().length < 6}
            >
              {busy ? "Verifying…" : "Sign in"}
            </button>
          </form>
          {/* The only way out of an expired code used to be "Use a different
              email", which people then used to re-enter the SAME address. The
              address is already on screen and already correct; asking for it
              again was the app pretending not to know it. */}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || waitSeconds > 0}
            aria-busy={busy}
            onClick={() => void send(true)}
          >
            {waitSeconds > 0 ? `Resend in ${waitSeconds}s` : "Resend code"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setSent(false);
              setCode("");
              // A different address is a different cooldown. Leaving the old
              // one running would meet the next person with a countdown they
              // did nothing to earn.
              setResendAt(0);
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
            aria-busy={busy}
          >
            {busy ? "Sending…" : "Email me a code"}
          </button>
        </form>
      )}
    </div>
  );
}
