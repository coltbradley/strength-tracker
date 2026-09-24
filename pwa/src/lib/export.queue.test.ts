import { describe, expect, it } from "vitest";
import { buildQueueExport } from "./export";

const setRow = (id: string) => ({
  id,
  session_id: "sess",
  exercise_id: "Barbell_Squat",
  load_kg: 100,
  reps: 5,
});

const entry = (
  state: "waiting" | "held" | "dead",
  user_id: string | null | undefined,
  id: string,
) => ({
  op: { kind: "insert", table: "sets", payload: setRow(id) },
  created_at: "2026-09-24T10:00:00.000Z",
  retries: 0,
  last_error: null,
  user_id,
  state,
  cause: null,
  retryable: false,
});

describe("buildQueueExport", () => {
  it("counts another account's held writes but never exports their contents (A-148)", () => {
    const bundle = buildQueueExport(
      [entry("waiting", "me", "mine"), entry("held", "someone-else", "theirs")],
      { Barbell_Squat: "Barbell Squat" },
      "test",
    );

    expect(bundle.summary).toEqual({ waiting: 1, held: 1, dead: 0 });
    const [mine, theirs] = bundle.items;
    expect(mine.row).toMatchObject({ id: "mine", load_kg: 100 });
    expect(mine.exercise_name).toBe("Barbell Squat");
    expect(theirs).toMatchObject({ state: "held", row: null, queued_by: null });
    expect(theirs).not.toHaveProperty("exercise_name");
    expect(JSON.stringify(theirs)).not.toContain("someone-else");
    expect(JSON.stringify(theirs)).not.toContain("theirs");
  });
});
