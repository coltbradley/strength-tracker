// Regression coverage for the "today" rule (audit finding a.1).
//
// The MCP server's calendar day must equal Postgres
// `(now() at time zone app_tz())::date`. This half pins the TypeScript
// formatter; the SQL half is pinned in scripts/validate-db.mjs, which asserts
// the same instants against the real migrations. Both files use the instant
// 2026-08-27T02:30:00Z (19:30 the previous day in America/Los_Angeles) -- if
// you change it in one, change it in the other.
//
//   deno test lib/dates.test.ts

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { assertIsoDate, isoDateInTz } from "./dates.ts";
import { ToolError } from "./errors.ts";

Deno.test("isoDateInTz: evening west of UTC stays on the local day", () => {
  // The bug: UTC said 2026-08-27, the lifter and the database said 2026-08-26.
  const instant = new Date("2026-08-27T02:30:00Z");
  assertEquals(isoDateInTz(instant, "America/Los_Angeles"), "2026-08-26");
  assertEquals(isoDateInTz(instant, "UTC"), "2026-08-27");
});

Deno.test("isoDateInTz: morning east of UTC is already the next day", () => {
  // The mirror-image failure, for a lifter who moves the config east.
  const instant = new Date("2026-08-26T23:30:00Z");
  assertEquals(isoDateInTz(instant, "Asia/Tokyo"), "2026-08-27");
  assertEquals(isoDateInTz(instant, "UTC"), "2026-08-26");
});

Deno.test("isoDateInTz: zero-padded and never locale-formatted", () => {
  const instant = new Date("2026-01-05T12:00:00Z");
  assertEquals(isoDateInTz(instant, "UTC"), "2026-01-05");
  // A US locale would render this 1/5/2026; formatToParts must not leak that.
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(isoDateInTz(instant, "UTC")), true);
});

Deno.test("isoDateInTz: DST boundary in the configured zone", () => {
  // 2026-11-01 01:30 PDT -> PST transition. Both sides of it are Nov 1 local.
  assertEquals(
    isoDateInTz(new Date("2026-11-01T08:30:00Z"), "America/Los_Angeles"),
    "2026-11-01",
  );
  assertEquals(
    isoDateInTz(new Date("2026-11-01T09:30:00Z"), "America/Los_Angeles"),
    "2026-11-01",
  );
});

Deno.test("isoDateInTz: an unusable stored zone fails loudly", () => {
  // Never degrade to UTC: a silent fallback is the defect being fixed.
  const err = assertThrows(
    () => isoDateInTz(new Date(), "Mars/Olympus_Mons"),
    Error,
    "Mars/Olympus_Mons",
  ) as Error;
  // Since multi-user a zone can come from either place, and the message has to
  // name BOTH or it sends the reader to fix the wrong row.
  assertEquals(err.message.includes("user_config"), true);
  assertEquals(err.message.includes("app_config"), true);
});

Deno.test("assertIsoDate: accepts real dates, rejects impossible ones", () => {
  assertEquals(assertIsoDate("2026-02-28", "effective_date"), "2026-02-28");
  for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026/01/01"]) {
    assertThrows(() => assertIsoDate(bad, "effective_date"), ToolError);
  }
});
