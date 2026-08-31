// "Something's wrong" for someone who cannot read a stack trace.
//
// The app knows far more about a failure than the person holding it does, so
// the report carries the diagnostics automatically and asks the human for the
// one thing only they have: what they were trying to do. Everything below the
// textarea is collected, not typed.
//
// The floating button that opens this lives in FabDock, which it shares with
// the coach.
import { useState } from "react";
import { Sheet } from "./Sheet";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { recentErrorLog, sendBugReport, toast } from "../lib/errors";
import { buildStamp } from "../lib/build";

interface ReportBugSheetProps {
  userId: string | null;
  route: string;
  onClose: () => void;
}

export function ReportBugSheet({ userId, route, onClose }: ReportBugSheetProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const status = useOutboxStatus();

  const submit = () => {
    setBusy(true);
    const sent = sendBugReport({
      message: text.trim(),
      diagnostics: {
        build: buildStamp(),
        route,
        user: userId ?? "signed out",
        online: navigator.onLine ? "yes" : "no",
        installed: window.matchMedia("(display-mode: standalone)").matches
          ? "yes"
          : "no",
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        // Queue depth is the single most useful number here: "my sets vanished"
        // and "my sets are sitting in the outbox" look identical from the couch.
        queued: status.pending,
        dead: status.dead,
        syncState: status.state,
        syncError: status.lastError,
        recentErrors: recentErrorLog(),
        userAgent: navigator.userAgent,
      },
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
      <div className="microcopy">
        Your app version, screen, sync queue and the last few errors are
        attached automatically. No need to describe them.
      </div>
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