// The coach's system prompt: string assertions on the prose that decides
// what the coach does with a session review and a due observation. There is
// no behavior to unit test beyond "the words are in there" — the prompt IS
// the product (prompt.ts's own header comment) — so these pin the exact
// substrings this task's rewrite must contain, the same way a docs change
// would be pinned by grepping for the sentence that matters.
//
//   deno test prompt.test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { systemPrompt } from "./prompt.ts";

const PROMPT = systemPrompt("2026-09-16", "kg");

Deno.test("REVIEWING A SESSION step 1 compares with get_session_diff", () => {
  assertStringIncludes(PROMPT, "get_session_diff");
  assertStringIncludes(PROMPT, "session_skips");
});

Deno.test(
  "REVIEWING A SESSION never tells them to follow the plan more closely",
  () => {
    assertStringIncludes(
      PROMPT,
      "Never tell them to follow the plan more closely",
    );
  },
);

Deno.test(
  "a big single-session e1RM move is checked before it counts as strength change",
  () => {
    assertStringIncludes(PROMPT, "20%");
    assertStringIncludes(PROMPT, "strength change");
  },
);

Deno.test(
  "a conclusion worth checking again is recorded with a check-back date",
  () => {
    assertStringIncludes(PROMPT, "record_observation");
    assertStringIncludes(PROMPT, "check_back_on");
  },
);

Deno.test(
  "a due observation is compared against get_trends before it is resolved",
  () => {
    assertStringIncludes(PROMPT, "get_trends");
    assertStringIncludes(PROMPT, "resolve_observation");
  },
);

Deno.test("in-app coach cannot confirm programs or live plan changes", () => {
  assertStringIncludes(PROMPT, "You cannot confirm from here");
  assertStringIncludes(PROMPT, "plan editor in the app");
  assertStringIncludes(PROMPT, "Claude Desktop");
  assertEquals(PROMPT.includes("confirm_change=true"), false);
});
