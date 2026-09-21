import { assertEquals } from "jsr:@std/assert@^1";
import {
  coachAdmission,
  isCoachUserAllowed,
  parseAllowlist,
} from "./allowlist.ts";

const UID = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

Deno.test("unset or blank allowlist is not configured (503)", () => {
  assertEquals(parseAllowlist(undefined), null);
  assertEquals(parseAllowlist(""), null);
  assertEquals(parseAllowlist("  "), null);
  assertEquals(coachAdmission(UID, null), {
    status: 503,
    error: "The coach is not configured",
  });
});

Deno.test("comma list admits only those uuids, case-insensitive", () => {
  const allow = parseAllowlist(` ${UID.toUpperCase()}, `);
  assertEquals(coachAdmission(UID, allow), { status: 200 });
  assertEquals(coachAdmission(OTHER, allow), {
    status: 403,
    error: "The coach isn't enabled for this account.",
  });
});

Deno.test("present but empty list admits nobody (403)", () => {
  const allow = parseAllowlist(",");
  assertEquals(allow instanceof Set, true);
  assertEquals(allow!.size, 0);
  assertEquals(coachAdmission(UID, allow), {
    status: 403,
    error: "The coach isn't enabled for this account.",
  });
});
