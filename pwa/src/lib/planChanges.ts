// A coach writes through the MCP server, outside the PWA's normal mutation
// helpers. This is the one boundary that tells an already-mounted Today screen
// to fetch the new plan rather than keeping its old IndexedDB-backed view.

const EVENT = "plan:changed";

/** Tools that can create, expose, or materially change a workout card. */
export function isWorkoutWritingTool(tool: string): boolean {
  return (
    tool === "upsert_program" ||
    tool === "confirm_program" ||
    tool === "update_planned_workout" ||
    tool === "repeat_planned_workout"
  );
}

/** Tell mounted plan consumers that the coach may have changed the schedule. */
export function notifyPlanChanged(target: EventTarget = window): void {
  target.dispatchEvent(new Event(EVENT));
}

/** Subscribe to coach-originated plan changes. Returns the unsubscribe. */
export function onPlanChanged(
  listener: () => void,
  target: EventTarget = window,
): () => void {
  target.addEventListener(EVENT, listener);
  return () => target.removeEventListener(EVENT, listener);
}
