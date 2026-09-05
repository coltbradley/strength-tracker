// Open the coach from anywhere in the app, optionally with a first turn ready
// to send.
//
// The coach sheet is owned by FabDock, which is mounted once in App and
// floats over every screen. A screen that wants to start a conversation (the
// review after a finished session) must not mount a SECOND sheet: two sheets
// means two threads, two abort controllers and two places to fix the same
// bug. So a screen asks, and the one dock answers. A window event rather than
// context, because the asker and the dock share no ancestor below App and a
// context provider for one message is more plumbing than the message.

export interface CoachOpenRequest {
  /** Sent as the first turn the moment the sheet opens, in the lifter's own
   *  voice ("Review my session from …"). Omit to open with an empty box. */
  prefill?: string;
}

const EVENT = "coach:open";

/** Ask the dock to open the coach. Safe to call when no dock is mounted: the
 *  event is dropped, which is also what happens before App has rendered. */
export function openCoach(req: CoachOpenRequest = {}): void {
  window.dispatchEvent(new CustomEvent<CoachOpenRequest>(EVENT, { detail: req }));
}

/** The dock's side. Returns the unsubscribe. */
export function onCoachOpen(fn: (req: CoachOpenRequest) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<CoachOpenRequest>).detail;
    fn(detail ?? {});
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
