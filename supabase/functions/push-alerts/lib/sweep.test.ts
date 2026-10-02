import { assertEquals } from "jsr:@std/assert@1";
import { type DueAlert, processDue, sendStamp } from "./sweep.ts";

const row = (id: string, fire_at: string): DueAlert => ({
  id,
  user_id: "u",
  kind: "checkin",
  label: "",
  fire_at,
});

Deno.test(
  "EDGE-1: a successful send stamps sent_at so the next sweep skips it",
  () => {
    const patch = sendStamp(true, "2026-10-01T12:00:00.000Z");
    assertEquals(patch, { sent_at: "2026-10-01T12:00:00.000Z" });
  },
);

Deno.test(
  "EDGE-1: a failed send records the error and leaves sent_at null",
  () => {
    const patch = sendStamp(false, "2026-10-01T12:00:00.000Z");
    assertEquals(patch.sent_at, undefined);
    assertEquals(patch.error, "every endpoint failed");
  },
);

Deno.test("EDGE-12: one throwing row does not abort the batch", async () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const fresh = "2026-10-01T11:58:00Z";
  const errors: string[] = [];
  const sentIds: string[] = [];
  const out = await processDue(
    [row("a", fresh), row("boom", fresh), row("c", fresh)],
    now,
    6 * 3_600_000,
    {
      stamp: async () => {},
      send: async (r) => {
        if (r.id === "boom") throw new Error("subscriptions: down");
        sentIds.push(r.id);
        return "sent";
      },
      onError: (r) => errors.push(r.id),
    },
  );
  assertEquals(out, { sent: 2, stale: 0, failed: 1 });
  assertEquals(sentIds, ["a", "c"]);
  assertEquals(errors, ["boom"]);
});

Deno.test(
  "EDGE-12: a stale row is stamped, not sent, and a throwing stamp is contained",
  async () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const stamped: string[] = [];
    const out = await processDue(
      [row("old", "2026-10-01T03:00:00Z"), row("old2", "2026-10-01T02:00:00Z")],
      now,
      6 * 3_600_000,
      {
        stamp: async (id) => {
          if (id === "old") throw new Error("stamp: down");
          stamped.push(id);
        },
        send: async () => "sent",
        onError: () => {},
      },
    );
    assertEquals(out, { sent: 0, stale: 1, failed: 1 });
    assertEquals(stamped, ["old2"]);
  },
);
