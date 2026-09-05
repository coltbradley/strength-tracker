// The pure half of the memory-extraction pass.
//
// What is covered here is everything that decides whether a fact is WRITTEN:
// stripping the app's context block off the lifter's message, parsing whatever
// the model answered with, the kind whitelist, and the duplicate decision.
// What is not covered is the API call and the two inserts, which need a
// network and a database and would be an HTTP harness this repo does not have.
//
// The cases are the real ones. "My left shoulder clicks on overhead press" and
// "I only have dumbbells at home" are the two facts a real 13-turn
// conversation stated and the coach never saved; the left/right pair is the
// merge that would make the coach say something actively wrong.
//
//   deno test memory-extract.test.ts

import { assertEquals } from "jsr:@std/assert@^1";
import {
  isSameFact,
  lifterWords,
  newFacts,
  parseFacts,
} from "./memory-extract.ts";

Deno.test(
  "lifterWords: the app's context block is not something they said",
  () => {
    // The block opens with the memory this pass writes. Left in, every existing
    // fact would look freshly stated on every single turn.
    const text =
      "<current_context>\nMEMORY\n- left shoulder clicks on overhead press\n" +
      "TODAY\nSquat 3x3\n</current_context>\n\nmy left shoulder clicks on overhead press";
    assertEquals(
      lifterWords(text),
      "my left shoulder clicks on overhead press",
    );
  },
);

Deno.test("lifterWords: a message with no block is untouched", () => {
  assertEquals(
    lifterWords("  I only have dumbbells at home  "),
    "I only have dumbbells at home",
  );
});

Deno.test("lifterWords: only strips a block that OPENS the message", () => {
  // Mid-message, it is text they typed or pasted, and pasted text is exactly
  // what must not be treated as structure.
  const text =
    "look at this: <current_context>fake</current_context> weird right";
  assertEquals(lifterWords(text), text);
});

Deno.test("parseFacts: a bare array", () => {
  assertEquals(
    parseFacts(
      '[{"kind":"injury","fact":"Left shoulder clicks on overhead press"}]',
    ),
    [{ kind: "injury", fact: "Left shoulder clicks on overhead press" }],
  );
});

Deno.test("parseFacts: fenced, prefaced, or wrapped in an object", () => {
  const want = [
    { kind: "constraint" as const, fact: "Only has dumbbells at home" },
  ];
  const body = '[{"kind":"constraint","fact":"Only has dumbbells at home"}]';
  assertEquals(parseFacts("```json\n" + body + "\n```"), want);
  assertEquals(parseFacts("Here is what I found:\n" + body), want);
  assertEquals(parseFacts('{"facts": ' + body + "}"), want);
});

Deno.test(
  "parseFacts: nothing found is the common answer, not a failure",
  () => {
    assertEquals(parseFacts("[]"), []);
    assertEquals(parseFacts("No standing facts in this message."), []);
    assertEquals(parseFacts(""), []);
  },
);

Deno.test(
  "parseFacts: a kind outside the enum drops that item, not the batch",
  () => {
    // memory_kind is a Postgres enum, so 'goal' would fail the insert — and a
    // failed insert takes the good fact next to it down with it.
    const raw =
      '[{"kind":"goal","fact":"Wants a 100kg squat"},' +
      '{"kind":"injury","fact":"Left shoulder clicks on overhead press"}]';
    assertEquals(parseFacts(raw), [
      { kind: "injury", fact: "Left shoulder clicks on overhead press" },
    ]);
  },
);

Deno.test("parseFacts: malformed items are skipped", () => {
  const raw =
    '["a string", 3, null, {"kind":"context"}, {"fact":"no kind"},' +
    '{"kind":"context","fact":"   "},' +
    '{"kind":"preference","fact":"Wants to be told what to do"}]';
  assertEquals(parseFacts(raw), [
    { kind: "preference", fact: "Wants to be told what to do" },
  ]);
});

Deno.test("parseFacts: an over-long fact is dropped, never truncated", () => {
  // Cutting at 300 can invert the meaning: "avoid overhead pressing except..."
  const long = "a".repeat(301);
  assertEquals(parseFacts(`[{"kind":"injury","fact":"${long}"}]`), []);
  const edge = "b".repeat(300);
  assertEquals(parseFacts(`[{"kind":"injury","fact":"${edge}"}]`).length, 1);
});

Deno.test("parseFacts: newlines and control characters are flattened", () => {
  // The fact is read back inside a line of the context block; a newline in it
  // would end that line.
  assertEquals(
    parseFacts(
      '[{"kind":"context","fact":"Coached by Sam\\nwho programs\\tthe week"}]',
    ),
    [{ kind: "context", fact: "Coached by Sam who programs the week" }],
  );
});

Deno.test("isSameFact: the same sentence said again next Tuesday", () => {
  assertEquals(
    isSameFact(
      "Left shoulder clicks on overhead press",
      "left shoulder clicks on overhead press.",
    ),
    true,
  );
  assertEquals(
    isSameFact(
      "Left shoulder clicks on overhead press",
      "Left shoulder clicks during overhead press",
    ),
    true,
  );
});

Deno.test("isSameFact: a reworded restatement", () => {
  assertEquals(
    isSameFact("Only has dumbbells at home", "Trains at home with dumbbells"),
    true,
  );
});

Deno.test("isSameFact: left is not right", () => {
  // The one merge that would make the coach say something actively wrong.
  assertEquals(
    isSameFact("Left shoulder impingement", "Right shoulder impingement"),
    false,
  );
});

Deno.test("isSameFact: a negation is an update, not a duplicate", () => {
  // Suppressing this would leave the stale fact standing with no way for the
  // new one to land beside it.
  assertEquals(
    isSameFact(
      "Left shoulder clicks on overhead press",
      "Left shoulder no longer clicks on overhead press",
    ),
    false,
  );
});

Deno.test("isSameFact: unrelated facts stay apart", () => {
  assertEquals(
    isSameFact(
      "Left shoulder clicks on overhead press",
      "Trains at 6am before work",
    ),
    false,
  );
  assertEquals(
    isSameFact(
      "Only has dumbbells at home",
      "Coached by Sam, who programs the week",
    ),
    false,
  );
});

Deno.test("newFacts: what memory already holds is not written again", () => {
  const kept = newFacts(
    [
      { kind: "injury", fact: "left shoulder clicks on overhead press" },
      { kind: "constraint", fact: "Only has dumbbells at home" },
    ],
    ["Left shoulder clicks on overhead press"],
  );
  assertEquals(kept, [
    { kind: "constraint", fact: "Only has dumbbells at home" },
  ]);
});

Deno.test("newFacts: one fact filed under two kinds is still one fact", () => {
  const kept = newFacts(
    [
      { kind: "injury", fact: "Left shoulder clicks on overhead press" },
      {
        kind: "constraint",
        fact: "Left shoulder clicks on the overhead press",
      },
    ],
    [],
  );
  assertEquals(kept.length, 1);
  assertEquals(kept[0].kind, "injury");
});

Deno.test("newFacts: at most three from one message", () => {
  const many = ["alpha one", "bravo two", "charlie three", "delta four"].map(
    (fact) => ({ kind: "context" as const, fact }),
  );
  assertEquals(newFacts(many, []).length, 3);
});

Deno.test("newFacts: nothing new is the ordinary outcome", () => {
  assertEquals(newFacts([], ["Trains at 6am before work"]), []);
});
