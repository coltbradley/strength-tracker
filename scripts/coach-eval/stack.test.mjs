import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { OWNER } from "./fixture.mjs";
import { createDb } from "./stack.mjs";

test("mcp_tokens insert requires auth.users row (coach-eval stack order)", async () => {
  const db = await createDb();
  const digest = createHash("sha256").update("stl_smoke").digest("hex");

  let fkRejected = false;
  try {
    await db.exec(`
      insert into mcp_tokens (token_sha256, user_id, label)
      values ('${digest}', '${OWNER}', 'smoke');
    `);
  } catch {
    fkRejected = true;
  }
  assert.ok(fkRejected, "expected FK violation without auth.users");

  await db.exec(`
    insert into auth.users (id, email) values ('${OWNER}', 'valentine@example.test') on conflict do nothing;
  `);
  await db.exec(`
    insert into mcp_tokens (token_sha256, user_id, label)
    values ('${digest}', '${OWNER}', 'smoke');
  `);
  const { rows } = await db.query(`select 1 from mcp_tokens where user_id = $1`, [OWNER]);
  assert.equal(rows.length, 1);
  await db.close();
});
