// The plan paragraph in the coach's context block. It is the one line that
// turns the plan into something the coach builds AGAINST rather than a document
// it could look up, so its three states — none, drafted, live with a current
// phase — each have to say the honest thing in words the model will act on.
import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} }));
vi.mock("./settings", () => ({ getUnit: () => "kg" }));
vi.mock("./data", () => ({ getTrainingPlan: vi.fn() }));

import { formatPlanLine } from "./coachContext";
import type { TrainingPlanRead } from "./data";

const PLAN: TrainingPlanRead = {
  plan: {
    id: "66666666-0000-4000-8000-000000000001",
    objective: "Squat 200 kg by spring.",
    starts_on: "2026-09-01",
    ends_on: "2026-12-20",
    confirmed_at: "2026-09-05T00:00:00Z",
  },
  phases: [
    {
      id: "77777777-0000-4000-8000-000000000001",
      position: 0,
      name: "Accumulation",
      starts_on: "2026-09-01",
      ends_on: "2026-10-12",
      focus: "hypertrophy on the squat pattern",
      progression: "add 2.5 kg when every working set hits the top of the range",
      sessions_per_week: 4,
    },
    {
      id: "77777777-0000-4000-8000-000000000002",
      position: 1,
      name: "Intensification",
      starts_on: "2026-10-13",
      ends_on: "2026-11-23",
      focus: "heavier triples",
      progression: null,
      sessions_per_week: 3,
    },
    {
      id: "77777777-0000-4000-8000-000000000003",
      position: 2,
      name: "Peak",
      starts_on: "2026-11-24",
      ends_on: "2026-12-20",
      focus: null,
      progression: null,
      sessions_per_week: null,
    },
  ],
};

describe("formatPlanLine", () => {
  it("says none, and how to make one, when there is no plan", () => {
    const line = formatPlanLine(null, "2026-09-05");
    expect(line).toMatch(/^PLAN: none is set/);
    expect(line).toContain("set_training_plan");
  });

  it("says drafted, not none, for an unconfirmed plan", () => {
    const line = formatPlanLine(
      { ...PLAN, plan: { ...PLAN.plan, confirmed_at: null } },
      "2026-09-05",
    );
    expect(line).toContain("not confirmed");
    expect(line).not.toContain("none is set");
    // and gives the coach nothing to file under
    expect(line).not.toContain("phase_id");
  });

  it("names the current phase, its focus, progression, the next phase and the id", () => {
    const line = formatPlanLine(PLAN, "2026-09-05");
    expect(line).toBe(
      'PLAN: Squat 200 kg by spring. Phase 1 of 3, "Accumulation" ' +
        "(2026-09-01 to 2026-10-12): hypertrophy on the squat pattern. " +
        "Progression: add 2.5 kg when every working set hits the top of the " +
        'range. Next: "Intensification" from 2026-10-13. ' +
        "[phase_id 77777777-0000-4000-8000-000000000001]",
    );
    // About 80 words: the design doc's budget for a paragraph read every turn.
    expect(line.split(/\s+/).length).toBeLessThan(80);
  });

  it("treats the phase's last day as inside it, and the next day as the next phase", () => {
    expect(formatPlanLine(PLAN, "2026-10-12")).toContain('"Accumulation"');
    expect(formatPlanLine(PLAN, "2026-10-13")).toContain('Phase 2 of 3, "Intensification"');
  });

  it("omits a progression that was not written, and says when a phase is the last", () => {
    const line = formatPlanLine(PLAN, "2026-12-01");
    expect(line).toContain('Phase 3 of 3, "Peak" (2026-11-24 to 2026-12-20).');
    expect(line).not.toContain("Progression:");
    expect(line).toContain("Last phase; the plan ends 2026-12-20.");
  });

  it("points at the next phase when today falls in a gap, with that phase's id", () => {
    const gapped: TrainingPlanRead = {
      ...PLAN,
      phases: [PLAN.phases[0], { ...PLAN.phases[1], starts_on: "2026-10-20" }],
    };
    const line = formatPlanLine(gapped, "2026-10-15");
    expect(line).toContain("No phase covers today");
    expect(line).toContain('"Intensification" from 2026-10-20');
    expect(line).toContain("[phase_id 77777777-0000-4000-8000-000000000002]");
  });

  it("says the plan has run out when every phase is past", () => {
    const line = formatPlanLine(PLAN, "2027-01-10");
    expect(line).toContain('"Peak", ended 2026-12-20');
    expect(line).toContain("revising from Claude Desktop");
  });
});
