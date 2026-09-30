import test from "node:test";
import assert from "node:assert/strict";
import { cleanupUsers } from "./lifecycle-utils.mjs";

test("cleanup attempts every user deletion and reports rejected deletions", async () => {
  const attempted = [];
  await assert.rejects(
    cleanupUsers(["user-a", "user-b"], async (user) => {
      attempted.push(user);
      if (user === "user-a") throw new Error("delete failed");
    }),
    /Could not delete 1 of 2 local Phase 2 test users/,
  );
  assert.deepEqual(attempted.sort(), ["user-a", "user-b"]);
});
