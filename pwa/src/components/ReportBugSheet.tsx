// "Something's wrong" for someone who cannot read a stack trace.
//
// The app knows far more about a failure than the person holding it does, so
// the report carries the diagnostics automatically and asks the human for the
// one thing only they have: what they were trying to do. Everything below the
// textarea is collected, not typed.
//
// It is also SHOWN. Attaching someone's app version, sync state and open
// session without putting them on screen is asking them to send a sealed
// envelope; the list under the box is the same array that goes in the
// payload, so what they read is what leaves the phone.
//
// The floating button that opens this lives in FabDock, which it shares with
// the coach.
import { Fragment, useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { useUnit } from "../hooks/useUnit";
import { cacheGet, cacheKeys } from "../lib/db";
import {
  appOpenedAt,
  buildBugDiagnostics,
  recentErrorLog,
  reportError,
  sendBugReport,
  toast,
  type BugDiagnostic,
} from "../lib/errors";
import { buildStamp } from "../lib/build";
import type { ActiveSession } from "../lib/types";

interface ReportBugSheetProps {
  userId: string | null;
  route: string;
  onClose: () => void;
}

export function ReportBugSheet({
  userId,
  route,
  onClose,
}: ReportBugSheetProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const status = useOutboxStatus();
  const unit = useUnit();

  // Whether a session is open right now, and which one. Half the reports
  // worth reading are about mid-workout behaviour, and "was there a session
  // running?" is the first question every one of them raises.
  useEffect(() => {
    let cancelled = false;
    void cacheGet<ActiveSession>(cacheKeys.activeSession)
      .then((s) => {
        if (!cancelled) setSession(s ?? null);
      })
      .catch((e: unknown) => reportError(e, "read open session for report"));
    return () => {
      cancelled = true;
    };
  }, []);

  // Built on every render rather than memoised: the clock and the open-session
  // age are in here, and a list that says 14:02 while sending 14:19 is the
  // exact dishonesty this display exists to remove.
  const diagnostics = (): BugDiagnostic[] =>
    buildBugDiagnostics({
      build: buildStamp(),
      route,
      userId,
      online: navigator.onLine,
      standalone: window.matchMedia("(display-mode: standalone)").matches,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      screen: {
        w: window.screen.width,
        h: window.screen.height,
        dpr: window.devicePixelRatio,
      },
      now: new Date(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      unit,
      openedAt: appOpenedAt(),
      session:
        session === null
          ? null
          : {
              id: session.id,
              label: session.workout_label,
              startedAt: session.started_at,
            },
      queued: status.pending,
      dead: status.dead,
      syncState: status.state,
      syncError: status.lastError,
      recentErrors: recentErrorLog(),
      userAgent: navigator.userAgent,
    });

  const rows = diagnostics();

  const submit = () => {
    setBusy(true);
    const sent = sendBugReport({
      message: text.trim(),
      diagnostics: diagnostics(),
    });
    setBusy(false);
    onClose();
    setText("");
    // Never claim it was filed when no DSN is configured — that would be a
    // silent drop dressed up as a thank-you.
    toast(
      sent
        ? "Report sent. Thank you."
        : "Report not sent: no error reporting configured on this build.",
      sent ? "info" : "error",
    );
  };

  return (
    <Sheet title="Report a problem" onClose={onClose}>
      <div className="field-label">WHAT WENT WRONG?</div>
      <textarea
        className="input bug-text"
        data-sheet-autofocus
        rows={4}
        placeholder="What were you doing, and what happened instead?"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="field-label">SENT WITH IT</div>
      <div className="microcopy">
        Read from the app, not from you. Nothing you have written or logged is
        in here.
      </div>
      <dl className="bug-diag">
        {rows.map((r) => (
          <Fragment key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </Fragment>
        ))}
      </dl>

      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || text.trim().length < 3}
        onClick={submit}
      >
        {busy ? "Sending…" : "Send report"}
      </button>
      {/* The only place the buttons' movability is discoverable. Shown here
          because it is the one moment someone is already looking at them. */}
      <div className="microcopy">
        In the way? Press and hold the buttons, then drag them anywhere.
      </div>
    </Sheet>
  );
}
