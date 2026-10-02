// The coercions every provider row passes through. Pure, so this is where the
// "unknown is not zero" rule is actually pinned.
//
//   deno test supabase/functions/endurance-sync/normalize.test.ts
// No assertion library, following lib/webpush_test.ts in push-alerts and for
// the reason it gives: jsr.io is not reachable from every place this runs, and
// an equality check does not need a dependency.
import {
  bpm,
  intervalsStartedAt,
  measurementsOnly,
  name,
  type NormalizedActivity,
  nonNeg,
  num,
  pollSince,
  secs,
  when,
} from "./normalize.ts";

function assertEquals(actual: unknown, expected: unknown, what?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${what ? what + ": " : ""}got ${a}, expected ${e}`);
  }
}

Deno.test("num: absent is null, zero is zero", () => {
  assertEquals(num(undefined), null);
  assertEquals(num(null), null);
  // The load-bearing one. Zero ascent on a track session is a MEASUREMENT.
  // Folding it into null is how a flat week becomes an unknown week, and this
  // schema draws that distinction on purpose.
  assertEquals(num(0), 0);
  assertEquals(num("12.5"), 12.5);
  assertEquals(num("nonsense"), null);
  assertEquals(num(NaN), null);
  assertEquals(num(Infinity), null);
});

Deno.test("nonNeg: a negative is provider noise, not data", () => {
  assertEquals(nonNeg(-1), null);
  assertEquals(nonNeg(0), 0);
  assertEquals(nonNeg(300), 300);
});

Deno.test("secs rounds to whole seconds", () => {
  assertEquals(secs(3599.6), 3600);
  assertEquals(secs(-5), null);
  assertEquals(secs(undefined), null);
});

Deno.test("bpm drops an impossible reading rather than clamping it", () => {
  assertEquals(bpm(151.8), 152);
  assertEquals(bpm(19), null);
  // A 300 bpm reading is a broken strap. Clamping to 250 would turn a sensor
  // fault into a training fact.
  assertEquals(bpm(300), null);
  assertEquals(bpm(null), null);
});

Deno.test("name is trimmed, capped and never empty-string", () => {
  assertEquals(name("  Morning Run  "), "Morning Run");
  assertEquals(name("   "), null);
  assertEquals(name(42), null);
  assertEquals(name("x".repeat(300))?.length, 200);
});

Deno.test("when accepts ISO and epoch seconds, rejects the rest", () => {
  assertEquals(when("2026-09-01T07:00:00Z"), "2026-09-01T07:00:00.000Z");
  assertEquals(when(1756710000), new Date(1756710000 * 1000).toISOString());
  assertEquals(when("not a date"), null);
  assertEquals(when(undefined), null);
});

Deno.test("EDGE-2: intervals start prefers UTC start_date and never reads local time as UTC", () => {
  // Pacific athlete: 06:15 local is 13:15Z. The zone-less local string must
  // not win over the UTC one, whatever zone the runtime happens to be in.
  assertEquals(
    intervalsStartedAt({
      start_date_local: "2026-09-30T06:15:00",
      start_date: "2026-09-30T13:15:00Z",
    }),
    "2026-09-30T13:15:00.000Z",
  );
  // intervals.icu sends start_date without a zone designator; it is UTC.
  assertEquals(
    intervalsStartedAt({
      start_date_local: "2026-09-30T06:15:00",
      start_date: "2026-09-30T13:15:00",
    }),
    "2026-09-30T13:15:00.000Z",
  );
  // Local time only: stored as wall clock (documented limitation), still
  // deterministic and independent of the runtime zone.
  assertEquals(
    intervalsStartedAt({ start_date_local: "2026-09-30T06:15:00" }),
    "2026-09-30T06:15:00.000Z",
  );
  assertEquals(intervalsStartedAt({}), null);
});

Deno.test("EDGE-4: a refresh write carries measurements but never the owner's name", () => {
  const row: NormalizedActivity = {
    source: "strava",
    external_id: "1",
    sport: "Run",
    started_at: "2026-09-30T13:15:00.000Z",
    elapsed_s: 100,
    moving_s: 90,
    distance_m: 1000,
    ascent_m: 0,
    descent_m: null,
    avg_hr: null,
    max_hr: null,
    avg_power_w: null,
    avg_cadence: null,
    name: "Upstream name",
  };
  const r = measurementsOnly(row);
  assertEquals("name" in r, false);
  assertEquals(r.sport, "Run");
  assertEquals(r.ascent_m, 0);
});

Deno.test("EDGE-5: poll window is per provider, clamped, and backfills a new one", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const overlap = 48 * 3_600_000;
  // No rows for THIS provider: full backfill window, not the other source's.
  assertEquals(
    pollSince(null, now, overlap, 400).toISOString(),
    new Date(now - 400 * 86_400_000).toISOString(),
  );
  assertEquals(
    pollSince("2026-09-20T00:00:00Z", now, overlap, 400).toISOString(),
    "2026-09-18T00:00:00.000Z",
  );
  // A future-dated row must not push the window into the future.
  assertEquals(
    pollSince("2027-01-01T00:00:00Z", now, overlap, 400).toISOString(),
    "2026-09-29T00:00:00.000Z",
  );
});
