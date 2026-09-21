// deno test --allow-env --allow-net tools/memory.test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerMemory } from "./memory.ts";

const MEMORY_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const h = (name: string, fixtures = {}) =>
  toolHarness(registerMemory, name, fixtures);

Deno.test("update_memory patches one owned fact and stamps updated_at", async () => {
  const t = h("update_memory", {
    coach_memory: [
      { id: MEMORY_ID, kind: "constraint", fact: "Apartment gym only" },
    ],
  });
  await t.run({
    id: MEMORY_ID,
    fact: "Apartment gym has a barbell now",
    kind: "context",
  });

  assertEquals(t.calls[0].table, "coach_memory");
  assertEquals(t.calls[0].filters.includes(`eq:id=${MEMORY_ID}`), true);
  assertEquals(t.calls[0].filters.includes(`eq:user_id=${TEST_USER}`), true);
  const update = t.calls[0].update as Record<string, unknown>;
  assertEquals(update.fact, "Apartment gym has a barbell now");
  assertEquals(update.kind, "context");
  assertEquals(typeof update.updated_at, "string");
});

Deno.test("update_memory reports an unknown or another user's id", async () => {
  const t = h("update_memory", { coach_memory: [] });
  const result = await t.run({
    id: MEMORY_ID,
    fact: "Apartment gym has a barbell now",
  });

  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "get_memory");
});

Deno.test("update_memory is a non-destructive write", () => {
  assertEquals(h("update_memory").meta.readOnly, false);
});
