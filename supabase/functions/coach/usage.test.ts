// The refusal row does not enforce the limit. It tells us that someone was
// refused, which is the only way to distinguish an honest cap from a broken
// usage check in the production logs.

import { assertEquals } from "jsr:@std/assert@^1";
import { failedTurnAccounting, recordRefusalUsage } from "./usage.ts";

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

Deno.test(
  "recordRefusalUsage stays quiet after a successful write",
  async () => {
    const reported: string[] = [];

    await recordRefusalUsage(
      async () => ({ error: null }),
      async (message) => {
        reported.push(message);
      },
    );

    assertEquals(reported, []);
  },
);

Deno.test(
  "EDGE-8: a turn that failed after generating is metered by estimate and still counts",
  () => {
    const out = failedTurnAccounting({
      failed: "stream reset",
      generationBegan: true,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      answerChars: 400,
      promptChars: 4000,
    });
    assertEquals(out.refused, null);
    assertEquals(out.usage.output, 100);
    assertEquals(out.usage.input, 1000);
    assertEquals(out.stop, "error: stream reset");
  },
);

Deno.test(
  "EDGE-8: a turn that failed before any generation stays refused and free",
  () => {
    const out = failedTurnAccounting({
      failed: "overloaded",
      generationBegan: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      answerChars: 0,
      promptChars: 4000,
    });
    assertEquals(out.refused, "overloaded");
    assertEquals(out.usage.output, 0);
  },
);

Deno.test(
  "EDGE-8: real usage and successful turns are never overwritten",
  () => {
    const real = { input: 50, output: 20, cacheRead: 0, cacheWrite: 0 };
    assertEquals(
      failedTurnAccounting({
        failed: "late",
        generationBegan: true,
        usage: real,
        answerChars: 400,
        promptChars: 4000,
      }).usage,
      real,
    );
    const ok = failedTurnAccounting({
      failed: null,
      generationBegan: true,
      usage: real,
      answerChars: 400,
      promptChars: 4000,
    });
    assertEquals(ok.refused, null);
    assertEquals(ok.usage, real);
  },
);
