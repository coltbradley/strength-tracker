// The 2026-09-30 phone: ten dead writes queued by the `main` build, repaired
// by THIS build through the real outbox. The fixture is the anonymized copy of
// the real export (scripts/fixtures/phone-queue-anonymized.json: fresh UUIDs,
// the note text replaced, everything else as exported). The items are loaded
// into IndexedDB in the OLD queue shape -- no correction_link, no receipt
// rows, only the fields main wrote -- and a mocked transport applies the real
// server's ordering rules (RLS needs the parent set; the trigger refuses a
// load that disagrees with its typed pair).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createOutbox, type OutboxTransport, type TransportError } from "./outbox";
import { getDb, resetDbForTests, type OutboxItem, type OutboxOp } from "./db";
import { isAcceptedAuthoredLoad } from "./setLoad";
import type { SetInsert } from "./types";

interface ExportItem {
  position: number;
  state: string;
  cause: string;
  queued_at: string;
  queued_by: string;
  attempts: number;
  last_error: string;
  operation: "insert sets" | "insert set_voids" | "insert set_notes";
  row: Record<string, unknown>;
}

const bundle = JSON.parse(
  readFileSync(join(process.cwd(), "..", "scripts", "fixtures", "phone-queue-anonymized.json"), "utf8"),
) as { app_version: string; items: ExportItem[] };

const OWNER = bundle.items[0].queued_by;
const OTHER = "99999999-9999-4999-8999-999999999999";

/** An export item as `main` left it in IndexedDB. Nothing newer than main. */
function oldShape(item: ExportItem): OutboxItem {
  const table = item.operation.replace("insert ", "") as "sets" | "set_voids" | "set_notes";
  const isSet = table === "sets";
  return {
    op: { kind: "insert", table, payload: item.row } as unknown as OutboxOp,
    created_at: item.queued_at,
    retries: item.attempts,
    last_error: item.last_error,
    status: "dead",
    last_code: isSet ? "23514" : "42501",
    last_status: isSet ? 400 : 403,
    user_id: item.queued_by,
  };
}

/** The server's ordering rules, as far as the outbox can observe them. */
function makeServer() {
  const sets = new Map<string, SetInsert>();
  const voided = new Set<string>();
  const notes = new Map<string, string>();
  const log: string[] = [];
  let who: string | null = OWNER;
  const refuse = (message: string, code: string, status: number): TransportError => ({ message, code, status });
  const transport: OutboxTransport = {
    async insert(table, payload) {
      const p = payload as Record<string, unknown> & { id?: string; set_id?: string };
      if (table === "sets") {
        const verdict = isAcceptedAuthoredLoad(p as unknown as SetInsert, "sets");
        if (!verdict.ok) {
          log.push(`refused ${p.id}`);
          return refuse(verdict.message, "23514", 400);
        }
        if (!sets.has(p.id as string)) sets.set(p.id as string, p as unknown as SetInsert);
        log.push(`set ${p.id}`);
        return null;
      }
      if (table === "set_voids" || table === "set_notes") {
        if (!sets.has(p.set_id as string)) {
          log.push(`rls ${table} ${p.set_id}`);
          return refuse(`new row violates row-level security policy for table "${table}"`, "42501", 403);
        }
        if (table === "set_voids") voided.add(p.set_id as string);
        else notes.set(p.set_id as string, p.note as string);
        log.push(`${table} ${p.set_id}`);
        return null;
      }
      throw new Error(`unexpected table ${table}`);
    },
    async update() {
      return null;
    },
  };
  return {
    transport,
    sets,
    voided,
    notes,
    log,
    live: () => [...sets.values()].filter((s) => !voided.has(s.id)),
    who: () => who,
    setWho: (w: string | null) => { who = w; },
  };
}

async function loadOldQueue() {
  const db = await getDb();
  for (const item of bundle.items) await db.add("outbox", oldShape(item));
}

describe("a main-build phone queue, repaired by this build", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDbForTests();
  });

  it("is the shape the export says it is", () => {
    expect(bundle.app_version).toBe("main");
    expect(bundle.items.map((i) => i.operation.replace("insert ", ""))).toEqual(
      ["sets", "sets", "sets", "set_voids", "sets", "sets", "set_notes", "sets", "sets", "set_voids"]);
  });

  it("reads every old item: owner, op shape, cause and retryable; only the seven sets are repairable", async () => {
    await loadOldQueue();
    const server = makeServer();
    const box = createOutbox({ getDb, transport: server.transport, currentUserId: server.who, isOnline: () => false });
    const rows = await box.inspect();
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.key)).toEqual([...rows.map((r) => r.key)].sort((a, b) => a - b));
    expect(rows.map((r) => [r.table, r.state, r.cause, r.retryable, r.loadRepairable])).toEqual(
      bundle.items.map((i) => i.operation === "insert sets"
        ? ["sets", "dead", "rejected", false, true]
        : [i.operation.replace("insert ", ""), "dead", "blocked", true, false]));
    expect(rows.every((r) => r.user_id === OWNER && r.correction_link === undefined)).toBe(true);
    expect(box.getStatus()).toMatchObject({ dead: 0 }); // counts are taken on first read
    await box.flush();
    expect(box.getStatus()).toMatchObject({ pending: 0, dead: 10, held: 0 });
  });

  it("does not offer repair to another account or to a signed-out phone", async () => {
    await loadOldQueue();
    const server = makeServer();
    const box = createOutbox({ getDb, transport: server.transport, currentUserId: server.who, isOnline: () => true });
    server.setWho(OTHER);
    const theirs = await box.inspect();
    expect(theirs.some((r) => r.loadRepairable)).toBe(false);
    expect(await box.repairDeadLoadSets(theirs)).toBe(false);
    server.setWho(null);
    expect(await box.repairDeadLoadSets(await box.inspect())).toBe(false);
    expect(server.log).toEqual([]);
  });

  it("repairs end to end: typed pounds restored, dependents parked then replayed, 5 live sets", async () => {
    await loadOldQueue();
    const server = makeServer();
    let online = false;
    const box = createOutbox({ getDb, transport: server.transport, currentUserId: server.who, isOnline: () => online });

    // before repair a retry changes nothing: sets are rejected, children wait on parents
    expect(await box.retryDead()).toEqual({ requeued: 0, stuck: 10 });

    const exported = (await box.inspect()).filter((r) => r.loadRepairable);
    expect(exported).toHaveLength(7);
    expect(await box.repairDeadLoadSets(exported)).toBe(true);

    // sets are queued again with the pounds the lifter typed; nothing else changed
    const queuedSets = (await box.inspect()).filter((r) => r.table === "sets");
    const typed = queuedSets.map((r) => {
      const p = (r.op as Extract<OutboxOp, { table: "sets" }>).payload;
      return [p.load_kg, p.entered_load, p.entered_unit, p.load_entry];
    });
    expect(typed).toEqual([
      [65.77, 145, "lb", "total"], [34.02, 75, "lb", "total"], [34.02, 75, "lb", "total"],
      [45.36, 100, "lb", "total"], [52.16, 115, "lb", "total"], [52.16, 115, "lb", "total"],
      [52.16, 115, "lb", "total"],
    ]);
    queuedSets.forEach((r, i) => {
      const was = bundle.items.filter((x) => x.operation === "insert sets")[i].row;
      const now = (r.op as Extract<OutboxOp, { table: "sets" }>).payload as unknown as Record<string, unknown>;
      expect({ ...now, entered_load: was.entered_load, entered_unit: was.entered_unit }).toEqual(was);
      expect(r.user_id).toBe(OWNER);
    });

    // voids and the note stay parked while their parent set is anywhere in the queue
    expect(await box.retryDead()).toEqual({ requeued: 0, stuck: 3 });

    online = true;
    await box.flush();
    expect(server.sets.size).toBe(7);
    expect(server.log.filter((l) => l.startsWith("refused"))).toEqual([]);
    expect((await box.inspect()).map((r) => [r.table, r.state])).toEqual(
      [["set_voids", "dead"], ["set_notes", "dead"], ["set_voids", "dead"]]);

    // parents acknowledged: now the dependents replay, in their queue order
    expect(await box.retryDead()).toEqual({ requeued: 3, stuck: 0 });
    await box.flush();
    expect(await box.inspect()).toEqual([]);
    expect(box.getStatus()).toMatchObject({ pending: 0, dead: 0, held: 0 });

    const live = server.live();
    expect(live.map((s) => [s.exercise_id, s.set_index, s.rpe ?? null, s.entered_load, s.entered_unit])).toEqual([
      ["Barbell_Squat", 5, null, 145, "lb"],
      ["Barbell_Bulgarian_Split_Squat", 2, 8, 75, "lb"],
      ["Seated_Leg_Curl", 4, null, 100, "lb"],
      ["Standing_Calf_Raises", 1, null, 115, "lb"],
      ["Standing_Calf_Raises", 2, 9, 115, "lb"],
    ]);
    expect(server.voided.size).toBe(2);
    expect([...server.notes.values()]).toEqual(["note text"]);
    expect(server.log.some((l) => l.startsWith("rls"))).toBe(false);
  });

  it("a void flushed before its parent is refused and stays parked, never lost", async () => {
    await loadOldQueue();
    const server = makeServer();
    const box = createOutbox({ getDb, transport: server.transport, currentUserId: server.who, isOnline: () => true });
    // force the dependents pending while the parents are still dead (e.g. a blanket retry from a build without the hold)
    const db = await getDb();
    for (const key of await db.getAllKeys("outbox")) {
      const item = (await db.get("outbox", key))!;
      if (item.op.table !== "sets") await db.put("outbox", { ...item, status: "pending" }, key);
    }
    await box.flush();
    expect(server.log.filter((l) => l.startsWith("rls"))).toHaveLength(3);
    expect((await box.inspect()).every((r) => r.state === "dead")).toBe(true);
    expect(server.live()).toEqual([]);
  });
});
