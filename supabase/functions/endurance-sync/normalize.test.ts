// The coercions every provider row passes through. Pure, so this is where the
// "unknown is not zero" rule is actually pinned.
//
//   deno test supabase/functions/endurance-sync/normalize.test.ts
import { assertEquals } from "jsr:@std/assert@^1";
import { bpm, name, nonNeg, num, secs, when } from "./normalize.ts";

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
