import { describe, expect, it } from "vitest";
import {
  buildCheckinOps,
  canSubmit,
  closeEpisodeOp,
  CHECKIN_TAGS,
  EMPTY_PAIN,
  injuryLabel,
  matchEpisode,
  mergeCheckins,
  pendingCheckins,
  stillThere,
  toggleTag,
  withPending,
  type CheckinDraft,
} from "./checkins";
import type { OutboxEntry } from "./outbox";
import type { CheckinRow, InjuryState } from "./types";

const NOW = "2026-09-16T15:00:00.000Z";
const TODAY = "2026-09-16";
const USER = "u1";

const draft = (over: Partial<CheckinDraft> = {}): CheckinDraft => ({
  note: "",
  tags: [],
  energy: null,
  pain: EMPTY_PAIN,
  ...over,
});

const injury = (over: Partial<InjuryState> = {}): InjuryState => ({
  episode_id: "ep-1",
  body_region: "Knee",
  side: "left",
  opened_on: "2026-09-02",
  closed_on: null,
  last_reported_at: "2026-09-15T08:00:00.000Z",
  last_reported_on: "2026-09-15",
  reports: 2,
  state: "active",
  ...over,
});

const entry = (op: OutboxEntry["op"], user = USER): OutboxEntry =>
  ({
    key: 1,
    op,
    table: op.table,
    created_at: NOW,
    retries: 0,
    last_error: null,
    user_id: user,
    state: "waiting",
  }) as unknown as OutboxEntry;

let n = 0;
const ids = () => `id-${++n}`;

describe("canSubmit", () => {
  it("is false when all three inputs are empty", () => {
    expect(canSubmit(draft())).toBe(false);
    expect(canSubmit(draft({ note: "   " }))).toBe(false);
  });
  it("is true for any one input alone", () => {
    expect(canSubmit(draft({ note: "tight hips" }))).toBe(true);
    expect(canSubmit(draft({ tags: ["great"] }))).toBe(true);
    expect(canSubmit(draft({ energy: 1 }))).toBe(true);
  });
});

describe("toggleTag", () => {
  it("adds and removes, keeping vocabulary order", () => {
    const on = toggleTag(toggleTag([], "sick"), "great");
    expect(on).toEqual(["great", "sick"]);
    expect(toggleTag(on, "great")).toEqual(["sick"]);
  });
  it("has the six tags in the agreed order", () => {
    expect(CHECKIN_TAGS.map((t) => t.value)).toEqual([
      "great",
      "slept_badly",
      "unusually_sore",
      "stressed",
      "sick",
      "pain",
    ]);
  });
});

describe("matchEpisode", () => {
  it("matches an open episode on exact region and side", () => {
    expect(matchEpisode([injury()], "Knee", "left")?.episode_id).toBe("ep-1");
    expect(matchEpisode([injury()], "Knee", "right")).toBeNull();
    expect(
      matchEpisode([injury({ closed_on: "2026-09-10" })], "Knee", "left"),
    ).toBeNull();
  });
  it("picks the most recently opened of several", () => {
    const older = injury({ episode_id: "old", opened_on: "2026-08-01" });
    const newer = injury({ episode_id: "new", opened_on: "2026-09-01" });
    expect(matchEpisode([older, newer], "Knee", "left")?.episode_id).toBe(
      "new",
    );
  });
  it("treats a null side as n/a", () => {
    expect(
      matchEpisode([injury({ side: null })], "Knee", "n/a")?.episode_id,
    ).toBe("ep-1");
  });
});

describe("buildCheckinOps", () => {
  const ctx = {
    userId: USER,
    now: NOW,
    today: TODAY,
    injuries: [injury()],
    newId: ids,
  };

  it("writes every column on a plain check-in", () => {
    const ops = buildCheckinOps(
      draft({ note: "  fine  ", energy: 4, tags: ["great"] }),
      ctx,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "insert", table: "checkins" });
    const p = (ops[0] as Extract<(typeof ops)[0], { table: "checkins" }>)
      .payload;
    expect(p).toEqual({
      id: expect.any(String),
      user_id: USER,
      kind: "spontaneous",
      recorded_at: NOW,
      note: "fine",
      energy: 4,
      feeling: null,
      tags: ["great"],
      episode_id: null,
      training_impact: null,
      session_id: null,
      activity_id: null,
    });
  });

  it("stores a blank note as null", () => {
    const ops = buildCheckinOps(draft({ energy: 2 }), ctx);
    expect((ops[0] as { payload: { note: unknown } }).payload.note).toBeNull();
  });

  it("files pain against a matching open episode without creating one", () => {
    const ops = buildCheckinOps(
      draft({
        tags: ["pain"],
        pain: { region: "Knee", side: "left", impact: "modified" },
      }),
      ctx,
    );
    expect(ops).toHaveLength(1);
    expect(
      (ops[0] as { payload: Record<string, unknown> }).payload,
    ).toMatchObject({
      episode_id: "ep-1",
      training_impact: "modified",
    });
  });

  it("creates an episode first when nothing matches, and links to it", () => {
    const ops = buildCheckinOps(
      draft({
        tags: ["pain"],
        pain: { region: "Ankle", side: "bilateral", impact: null },
      }),
      ctx,
    );
    expect(ops.map((o) => o.table)).toEqual(["symptom_episodes", "checkins"]);
    const ep = (ops[0] as { payload: Record<string, unknown> }).payload;
    expect(ep).toEqual({
      id: expect.any(String),
      user_id: USER,
      body_region: "Ankle",
      side: "bilateral",
      opened_on: TODAY,
    });
    expect(
      (ops[1] as { payload: Record<string, unknown> }).payload.episode_id,
    ).toBe(ep.id);
  });

  it("saves pain with no region as a tag and an impact, with no episode", () => {
    const ops = buildCheckinOps(
      draft({
        tags: ["pain"],
        pain: { region: null, side: null, impact: "stopped" },
      }),
      ctx,
    );
    expect(ops).toHaveLength(1);
    expect(
      (ops[0] as { payload: Record<string, unknown> }).payload,
    ).toMatchObject({
      episode_id: null,
      training_impact: "stopped",
    });
  });

  it("drops pain answers when the pain tag is off", () => {
    const ops = buildCheckinOps(
      draft({
        tags: ["sick"],
        pain: { region: "Knee", side: "left", impact: "none" },
      }),
      ctx,
    );
    expect(
      (ops[0] as { payload: Record<string, unknown> }).payload,
    ).toMatchObject({
      episode_id: null,
      training_impact: null,
    });
  });
});

describe("stillThere", () => {
  it("asks about open episodes last reported on an earlier day", () => {
    expect(stillThere([injury()], TODAY).map((e) => e.episode_id)).toEqual([
      "ep-1",
    ]);
  });
  it("does not ask again once reported today, or about closed episodes", () => {
    expect(stillThere([injury({ last_reported_on: TODAY })], TODAY)).toEqual(
      [],
    );
    expect(stillThere([injury({ closed_on: "2026-09-15" })], TODAY)).toEqual(
      [],
    );
  });
  it("uses opened_on when an episode has never been reported", () => {
    const fresh = injury({
      last_reported_at: null,
      last_reported_on: null,
      opened_on: TODAY,
    });
    expect(stillThere([fresh], TODAY)).toEqual([]);
    const old = injury({
      last_reported_at: null,
      last_reported_on: null,
      opened_on: "2026-09-01",
    });
    expect(stillThere([old], TODAY)).toHaveLength(1);
  });
  it("shows at most three, most recently reported first", () => {
    const list = ["a", "b", "c", "d"].map((id, i) =>
      injury({
        episode_id: id,
        last_reported_on: `2026-09-1${i}`,
        last_reported_at: `2026-09-1${i}T08:00:00.000Z`,
      }),
    );
    expect(stillThere(list, TODAY).map((e) => e.episode_id)).toEqual([
      "d",
      "c",
      "b",
    ]);
  });
});

describe("closeEpisodeOp", () => {
  it("is an update that sets closed_on to today", () => {
    expect(closeEpisodeOp("ep-1", TODAY)).toEqual({
      kind: "update",
      table: "symptom_episodes",
      id: "ep-1",
      patch: { closed_on: TODAY },
    });
  });
});

describe("injuryLabel", () => {
  it("reads naturally for each side", () => {
    expect(injuryLabel(injury())).toBe("left knee");
    expect(injuryLabel(injury({ side: "bilateral" }))).toBe(
      "knee (both sides)",
    );
    expect(injuryLabel(injury({ side: "n/a" }))).toBe("knee");
  });
});

describe("pending merges", () => {
  const ctx = {
    userId: USER,
    now: NOW,
    today: TODAY,
    injuries: [],
    newId: ids,
  };
  const ops = buildCheckinOps(
    draft({
      tags: ["pain"],
      pain: { region: "Hip", side: "right", impact: null },
    }),
    ctx,
  );

  it("reads this user's queued check-ins and ignores another user's", () => {
    const entries = [entry(ops[1]), entry(ops[1], "someone-else")];
    expect(pendingCheckins(entries, USER)).toHaveLength(1);
  });

  it("merges server and pending check-ins by id, oldest first", () => {
    const server: CheckinRow[] = [
      {
        id: "s1",
        recorded_at: "2026-09-16T07:00:00.000Z",
        note: null,
        energy: 3,
        tags: [],
        training_impact: null,
        episode_id: null,
      },
    ];
    const merged = mergeCheckins(server, [
      ...server,
      ...pendingCheckins([entry(ops[1])], USER),
    ]);
    expect(merged.map((r) => r.id)).toEqual([
      "s1",
      (ops[1] as { payload: { id: string } }).payload.id,
    ]);
  });

  it("adds queued episodes, queued reports and queued closes to the server's injuries", () => {
    const closing = entry(closeEpisodeOp("ep-1", TODAY));
    const result = withPending(
      [injury()],
      [entry(ops[0]), entry(ops[1]), closing],
      USER,
      () => TODAY,
    );
    const hip = result.find((e) => e.body_region === "Hip");
    expect(hip).toMatchObject({
      side: "right",
      opened_on: TODAY,
      last_reported_on: TODAY,
      closed_on: null,
    });
    expect(result.find((e) => e.episode_id === "ep-1")?.closed_on).toBe(TODAY);
  });
});
