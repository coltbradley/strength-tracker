// The two things that float over the app: ask the coach, report a problem.
//
// One dock rather than two loose buttons. They share a position, move
// together, and cannot be dragged on top of each other.
//
// OFFLINE is shown here rather than discovered on tap. The rest of this app
// works underground on purpose — sets queue and sync later — but the coach is
// an API call and simply cannot. A disabled button that says why is honest;
// one that looks live and fails after a spinner is not.
import { useEffect, useState } from "react";
import { useSetting } from "../hooks/useSettings";
import { useFabDrag, useOnline } from "../hooks/useFabDrag";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { CoachSheet } from "./CoachSheet";
import { ReportBugSheet } from "./ReportBugSheet";
import { onCoachOpen } from "../lib/coachOpen";
import { toast } from "../lib/errors";

interface FabDockProps {
  userId: string | null;
  route: string;
}

export function FabDock({ userId, route }: FabDockProps) {
  const pos = useSetting("bugButtonPos");
  const drag = useFabDrag(pos);
  const online = useOnline();
  const status = useOutboxStatus();
  const [open, setOpen] = useState<"coach" | "bug" | null>(null);
  /** a first turn a screen asked to have sent when the coach opens */
  const [prefill, setPrefill] = useState<string | undefined>(undefined);

  const offlineNote = () =>
    toast(
      "The coach needs a connection. Your sets still log offline as usual.",
      "info",
    );

  // A drag ends with a click on whichever button was under the finger; that
  // click must not open anything.
  const tap = (what: "coach" | "bug") => () => {
    if (drag.movedRef.current) return;
    if (what === "coach" && !online) {
      offlineNote();
      return;
    }
    setPrefill(undefined);
    setOpen(what);
  };

  // Screens open the coach through this rather than mounting their own sheet
  // (lib/coachOpen.ts). Same offline rule as the button: a review that cannot
  // be sent is a toast, not a sheet with a spinner.
  useEffect(
    () =>
      onCoachOpen((req) => {
        if (!online) {
          offlineNote();
          return;
        }
        setPrefill(req.prefill);
        setOpen("coach");
      }),
    [online],
  );

  const close = () => {
    setOpen(null);
    setPrefill(undefined);
  };

  return (
    <>
      <div
        ref={drag.ref}
        className={`fab-dock${drag.held ? " fab-dock-held" : ""}`}
        style={drag.style}
        {...drag.handlers}
      >
        <button
          type="button"
          className={`fab-btn fab-coach${online ? "" : " fab-btn-off"}`}
          aria-label={
            online
              ? "ask the coach (press and hold to move)"
              : "ask the coach — offline, needs a connection"
          }
          aria-disabled={!online}
          onClick={tap("coach")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 6.5h15v10h-8l-4.5 3.5v-3.5h-2.5z" />
              <path d="M9 10.5h6M9 13h4" />
            </g>
          </svg>
          {!online && <span className="fab-off-dot" aria-hidden="true" />}
        </button>

        <button
          type="button"
          className="fab-btn fab-bug"
          aria-label="report a problem (press and hold to move)"
          onClick={tap("bug")}
        >
          {/* Drawn, not an emoji: emoji render differently on every platform
              and this has to read at 20px on a cream card. */}
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <rect x="8" y="7.5" width="8" height="12" rx="4" />
              <path d="M8 11.5H4M8 15.5H4.5M8 19H5M16 11.5h4M16 15.5h3.5M16 19h3" />
              <path d="M9.5 7a2.5 2.5 0 0 1 5 0" />
            </g>
          </svg>
          {status.pending > 0 && (
            <span className="fab-queue" aria-hidden="true">
              {status.pending > 9 ? "9+" : status.pending}
            </span>
          )}
        </button>
      </div>

      {open === "coach" && <CoachSheet onClose={close} prefill={prefill} />}
      {open === "bug" && (
        <ReportBugSheet userId={userId} route={route} onClose={close} />
      )}
    </>
  );
}
