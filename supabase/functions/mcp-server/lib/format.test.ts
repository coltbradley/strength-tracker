// humanKg: a derived weight is read by a person, so no float tails.
//
//   deno test lib/format.test.ts

import { assertEquals } from "jsr:@std/assert@^1";
import { humanKg } from "./format.ts";

Deno.test("humanKg: at most one decimal, no .0, no float tail; quarter kg exact", () => {
  assertEquals(humanKg(102.06), "102.1");
  assertEquals(humanKg(100), "100");
  assertEquals(humanKg(0.1 + 0.2), "0.3");
  assertEquals(humanKg(21.25), "21.25");
  assertEquals(humanKg(204.12 / 2), "102.1");
  assertEquals(humanKg(61.25 / 2), "30.6");
  for (let c = 0; c <= 100000; c += 7) {
    const s = humanKg(c / 100);
    if (!/^\d+(\.\d)?$/.test(s) && !/^\d+\.(25|75)$/.test(s)) throw new Error(`${c / 100} -> ${s}`);
  }
});
