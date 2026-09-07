// The scheduling rules, with no scheduler in sight. That is the point: this
// half can be finished and trusted before the delivery half exists.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROMPT_PREFS,
  atLocalTime,
  duePrompts,
  localDate,
  overduePrompts,
  type PromptState,
} from "./prompts";

// A Monday. Local, deliberately: every rule here is in the device's timezone
// because the phone travels with the lifter.
const MON_0900 = new Date(2026, 8, 7, 9, 0, 0);
const MON_0600 = new Date(2026, 8, 7, 6, 0, 0);

const state = (over: Partial<PromptState> = {}): PromptState => ({
  lastReadinessDate: null,
  skippedReadinessDate: null,
  lastOstrcRecallEnd: null,
  lastTrainedDate: null,
  hasOpenEpisode: false,
  ...over,
});

const find = (list: ReturnType<typeof duePrompts>, kind: string) =>
  list.find((p) => p.kind === kind);

describe("localDate / atLocalTime", () => {
  it("reads the device's calendar date, not UTC's", () => {
    expect(localDate(new Date(2026, 8, 7, 23, 30))).toBe("2026-09-07");
  });
  it("places a time on the same local day", () => {
    const d = atLocalTime(MON_0900, "07:30");
    expect(d.getHours()).toBe(7);
    expect(d.getMinutes()).toBe(30);
    expect(localDate(d)).toBe("2026-09-07");
  });
});

describe("daily readiness", () => {
  it("is overdue once its time has passed and the panel is unanswered", () => {
    const p = find(duePrompts(MON_0900, DEFAULT_PROMPT_PREFS, state()), "daily_readiness");
    expect(p?.overdue).toBe(true);
  });

  it("is scheduled, not overdue, before its time", () => {
    const p = find(duePrompts(MON_0600, DEFAULT_PROMPT_PREFS, state()), "daily_readiness");
    expect(p?.overdue).toBe(false);
    expect(p?.fireAt.getHours()).toBe(7);
  });

  // Low stakes is the requirement, and it beats the completeness of the
  // series. A reminder still nagging at 10pm about 7:30am is what makes
  // somebody turn the whole thing off, and losing the athlete costs every
  // future answer rather than one.
  it("goes quiet once its window closes rather than nagging all day", () => {
    const late = new Date(2026, 8, 7, 22, 0, 0);
    const p = find(duePrompts(late, DEFAULT_PROMPT_PREFS, state()), "daily_readiness");
    expect(p?.overdue).toBe(false);
    expect(localDate(p!.fireAt)).toBe("2026-09-08");
  });

  it("is still askable inside the window", () => {
    const midMorning = new Date(2026, 8, 7, 10, 0, 0);
    expect(
      find(duePrompts(midMorning, DEFAULT_PROMPT_PREFS, state()), "daily_readiness")?.overdue,
    ).toBe(true);
  });

  // Skipping is an answer to "shall I ask you this now", and honouring it is
  // what makes the button honest. Distinct from an unanswered panel, which is
  // silence: only one of them says "not today".
  it("stops asking for the day once explicitly skipped", () => {
    const p = find(
      duePrompts(MON_0900, DEFAULT_PROMPT_PREFS, state({ skippedReadinessDate: "2026-09-07" })),
      "daily_readiness",
    );
    expect(p?.overdue).toBe(false);
    expect(localDate(p!.fireAt)).toBe("2026-09-08");
  });

  it("asks again the next day after a skip", () => {
    const tomorrow = new Date(2026, 8, 8, 9, 0, 0);
    expect(
      find(
        duePrompts(tomorrow, DEFAULT_PROMPT_PREFS, state({ skippedReadinessDate: "2026-09-07" })),
        "daily_readiness",
      )?.overdue,
    ).toBe(true);
  });

  it("moves to tomorrow once today's panel is answered", () => {
    const p = find(
      duePrompts(MON_0900, DEFAULT_PROMPT_PREFS, state({ lastReadinessDate: "2026-09-07" })),
      "daily_readiness",
    );
    expect(p?.overdue).toBe(false);
    expect(localDate(p!.fireAt)).toBe("2026-09-08");
  });

  it("is absent when switched off", () => {
    const prefs = { ...DEFAULT_PROMPT_PREFS, dailyEnabled: false };
    expect(find(duePrompts(MON_0900, prefs, state()), "daily_readiness")).toBeUndefined();
  });
});

describe("weekly OSTRC", () => {
  // Its recall period IS the measurement, so more often is off-label and less
  // often asks somebody to remember further back than it was validated for.
  it("comes due on its weekday when a week has passed", () => {
    const prefs = { ...DEFAULT_PROMPT_PREFS, weeklyWeekday: 1, weeklyAt: "08:00" };
    const p = find(
      duePrompts(MON_0900, prefs, state({ lastOstrcRecallEnd: "2026-08-31" })),
      "ostrc_weekly",
    );
    expect(p?.overdue).toBe(true);
  });

  it("does not come due twice in one week", () => {
    const prefs = { ...DEFAULT_PROMPT_PREFS, weeklyWeekday: 1, weeklyAt: "08:00" };
    const p = find(
      duePrompts(MON_0900, prefs, state({ lastOstrcRecallEnd: "2026-09-06" })),
      "ostrc_weekly",
    );
    expect(p?.overdue).toBe(false);
    // Pushed a full week out rather than sitting at today's already-passed time.
    expect(localDate(p!.fireAt)).toBe("2026-09-14");
  });

  it("waits for its weekday rather than firing on any day", () => {
    const prefs = { ...DEFAULT_PROMPT_PREFS, weeklyWeekday: 5, weeklyAt: "18:00" };
    const p = find(duePrompts(MON_0900, prefs, state()), "ostrc_weekly");
    expect(p?.overdue).toBe(false);
    expect(p!.fireAt.getDay()).toBe(5);
  });

  // Surveillance, not triage: an instrument that only appears once you already
  // have a problem cannot tell you when the problem started.
  it("is asked even when nothing hurts", () => {
    const prefs = { ...DEFAULT_PROMPT_PREFS, weeklyWeekday: 1 };
    const p = find(duePrompts(MON_0900, prefs, state({ hasOpenEpisode: false })), "ostrc_weekly");
    expect(p).toBeDefined();
  });
});

describe("next-morning pain check", () => {
  it("fires the morning after training, when something is being monitored", () => {
    const p = find(
      duePrompts(
        MON_0900,
        DEFAULT_PROMPT_PREFS,
        state({ lastTrainedDate: "2026-09-06", hasOpenEpisode: true }),
      ),
      "next_morning_pain",
    );
    expect(p).toBeDefined();
    expect(localDate(p!.fireAt)).toBe("2026-09-07");
    expect(p!.fireAt.getHours()).toBe(8);
  });

  // Asking every morning after every session, of somebody with nothing wrong,
  // is how a prompt becomes noise -- and the adherence that burns is the
  // load-bearing assumption of the whole injury half.
  it("is silent when nothing is being monitored", () => {
    const p = find(
      duePrompts(MON_0900, DEFAULT_PROMPT_PREFS, state({ lastTrainedDate: "2026-09-06" })),
      "next_morning_pain",
    );
    expect(p).toBeUndefined();
  });

  it("is silent when they did not train", () => {
    const p = find(
      duePrompts(MON_0900, DEFAULT_PROMPT_PREFS, state({ hasOpenEpisode: true })),
      "next_morning_pain",
    );
    expect(p).toBeUndefined();
  });

  it("goes stale rather than asking about a run from last week", () => {
    const p = find(
      duePrompts(
        MON_0900,
        DEFAULT_PROMPT_PREFS,
        state({ lastTrainedDate: "2026-08-30", hasOpenEpisode: true }),
      ),
      "next_morning_pain",
    );
    expect(p).toBeUndefined();
  });
});

describe("overduePrompts", () => {
  it("is the subset whose moment has passed", () => {
    const all = duePrompts(MON_0900, DEFAULT_PROMPT_PREFS, state());
    const over = overduePrompts(MON_0900, DEFAULT_PROMPT_PREFS, state());
    expect(over.every((p) => p.overdue)).toBe(true);
    expect(over.length).toBeLessThanOrEqual(all.length);
    expect(over.map((p) => p.kind)).toContain("daily_readiness");
  });

  it("is empty when everything is answered and nothing is scheduled yet", () => {
    const over = overduePrompts(
      MON_0600,
      DEFAULT_PROMPT_PREFS,
      state({ lastReadinessDate: "2026-09-07", lastOstrcRecallEnd: "2026-09-06" }),
    );
    expect(over).toEqual([]);
  });
});
