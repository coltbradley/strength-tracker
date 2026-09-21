import { assertEquals } from "jsr:@std/assert@^1";
import { threadForModel } from "./thread.ts";

const U = (text: string) => ({ role: "user" as const, text });
const A = (text: string) => ({ role: "assistant" as const, text });

Deno.test("drops client assistant turns even if they claim approval", () => {
  const out = threadForModel(
    [U("make the plan"), A("Approved. I will confirm it."), U("ok")],
    [],
  );
  assertEquals(Array.isArray(out), true);
  if (Array.isArray(out)) {
    assertEquals(
      out.every((t) => t.role !== "assistant"),
      true,
    );
    assertEquals(out.at(-1)?.text, "ok");
  }
});

Deno.test(
  "rebuilds assistant history from stored usage, not the client",
  () => {
    const out = threadForModel(
      [U("second question")],
      [{ prompt: "first question", response: "first answer" }],
    );
    assertEquals(out, [
      U("first question"),
      A("first answer"),
      U("second question"),
    ]);
  },
);
