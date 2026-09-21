import { assertEquals } from "jsr:@std/assert@^1";
import { isCoachUserAllowed, parseAllowlist } from "./allowlist.ts";

const UID = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

Deno.test("unset or blank allowlist is fail-open", () => {
  assertEquals(parseAllowlist(undefined), null);
  assertEquals(parseAllowlist(""), null);
  assertEquals(parseAllowlist("  "), null);
  assertEquals(isCoachUserAllowed(UID, null), true);
});

Deno.test("comma list admits only those uuids, case-insensitive", () => {
  const allow = parseAllowlist(` ${UID.toUpperCase()}, `);
  assertEquals(isCoachUserAllowed(UID, allow), true);
  assertEquals(isCoachUserAllowed(OTHER, allow), false);
});

Deno.test("present but empty list admits nobody", () => {
  const allow = parseAllowlist(",");
  assertEquals(allow instanceof Set, true);
  assertEquals(allow!.size, 0);
  assertEquals(isCoachUserAllowed(UID, allow), false);
});
