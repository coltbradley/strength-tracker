// The refusal row does not enforce the limit. It tells us that someone was
// refused, which is the only way to distinguish an honest cap from a broken
// usage check in the production logs.

import { assertEquals } from "jsr:@std/assert@^1";
import { recordRefusalUsage } from "./usage.ts";

Deno.test("recordRefusalUsage reports a returned PostgREST error", async () => {
  const reported: string[] = [];

  await recordRefusalUsage(
    async () => ({ error: { message: "permission denied" } }),
    async (message) => {
      reported.push(message);
    },
  );

  assertEquals(reported, ["permission denied"]);
});

Deno.test("recordRefusalUsage reports a thrown transport error", async () => {
  const reported: string[] = [];

  await recordRefusalUsage(
    async () => {
      throw new Error("network failed");
    },
    async (message) => {
      reported.push(message);
    },
  );

  assertEquals(reported, ["network failed"]);
});

Deno.test("recordRefusalUsage stays quiet after a successful write", async () => {
  const reported: string[] = [];

  await recordRefusalUsage(
    async () => ({ error: null }),
    async (message) => {
      reported.push(message);
    },
  );

  assertEquals(reported, []);
});
