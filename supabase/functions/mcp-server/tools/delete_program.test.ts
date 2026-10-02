//   deno test --allow-env --allow-net tools/delete_program.test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { TEST_USER, toolHarness } from "../lib/testing.ts";
import { registerDeleteProgram } from "./delete_program.ts";

const PROGRAM = "00000000-0000-4000-8000-0000000000aa";
const confirmed = {
  programs: [
    { id: PROGRAM, name: "Split", confirmed_at: "2026-09-01T00:00:00Z" },
  ],
};
const draft = {
  programs: [{ id: PROGRAM, name: "Split", confirmed_at: null }],
};
const ephemeral = { requestId: "test-request", ephemeral: true };

Deno.test("MCP-17: the coach's ephemeral token cannot delete a confirmed program, even with the flag", async () => {
  const t = toolHarness(
    registerDeleteProgram,
    "delete_program",
    confirmed,
    TEST_USER,
    ephemeral,
  );
  const res = await t.run({
    program_id: PROGRAM,
    confirm_delete_confirmed: true,
  });
  assertEquals(res.isError, true);
  assertStringIncludes(res.content[0].text, "in-app coach cannot");
  assertEquals(t.calls.every((c) => c.update === undefined), true);
});

Deno.test("MCP-17: a permanent token still deletes a confirmed program with the flag", async () => {
  const t = toolHarness(registerDeleteProgram, "delete_program", confirmed);
  const res = await t.run({
    program_id: PROGRAM,
    confirm_delete_confirmed: true,
  });
  assertEquals(res.isError, undefined);
});

Deno.test("MCP-17: an unconfirmed draft stays deletable by the coach", async () => {
  const t = toolHarness(
    registerDeleteProgram,
    "delete_program",
    draft,
    TEST_USER,
    ephemeral,
  );
  const res = await t.run({ program_id: PROGRAM });
  assertEquals(res.isError, undefined);
});
