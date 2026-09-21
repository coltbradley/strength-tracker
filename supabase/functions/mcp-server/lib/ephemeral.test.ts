import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { refuseIfEphemeral, ToolError } from "./errors.ts";
import { TEST_USER, toolHarness } from "./testing.ts";
import { registerConfirmProgram } from "../tools/confirm_program.ts";

Deno.test("refuseIfEphemeral throws for ephemeral callers", () => {
  assertThrows(
    () =>
      refuseIfEphemeral(
        { requestId: "t", ephemeral: true },
        "confirm a program",
      ),
    ToolError,
    "The in-app coach cannot confirm a program. Confirm from Claude Desktop or the plan editor.",
  );
});

Deno.test("refuseIfEphemeral allows permanent callers", () => {
  refuseIfEphemeral({ requestId: "t", ephemeral: false }, "confirm a program");
});

Deno.test("confirm_program refuses ephemeral callers", async () => {
  const h = toolHarness(
    registerConfirmProgram,
    "confirm_program",
    {},
    TEST_USER,
    { requestId: "test-request", ephemeral: true },
  );
  const res = await h.run({
    program_id: "00000000-0000-4000-8000-000000000099",
  });
  assertEquals(res.isError, true);
});
