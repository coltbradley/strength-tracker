import { describe, expect, it } from "vitest";
import {
  isWorkoutWritingTool,
  notifyPlanChanged,
  onPlanChanged,
} from "./planChanges";

describe("coach plan changes", () => {
  it("identifies only tools that can change a workout someone can start", () => {
    expect(isWorkoutWritingTool("upsert_program")).toBe(true);
    expect(isWorkoutWritingTool("confirm_program")).toBe(true);
    expect(isWorkoutWritingTool("update_planned_workout")).toBe(true);
    expect(isWorkoutWritingTool("repeat_planned_workout")).toBe(true);
    expect(isWorkoutWritingTool("get_program")).toBe(false);
  });

  it("notifies an open Today screen after a workout-writing turn", () => {
    const target = new EventTarget();
    let calls = 0;
    const stop = onPlanChanged(() => (calls += 1), target);

    notifyPlanChanged(target);
    stop();
    notifyPlanChanged(target);

    expect(calls).toBe(1);
  });
});
