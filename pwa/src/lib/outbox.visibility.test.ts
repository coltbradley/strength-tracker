// @vitest-environment jsdom
//
// A locked or backgrounded phone is not an `online` event — the connection
// never dropped, the tab was just asleep — so a write queued right before
// it locked could sit QUEUED until some unrelated write nudged the
// flusher. Foreground is exactly the moment someone is looking at the pill
// wondering why.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOutbox, type OutboxTransport } from "./outbox";
import { getDb, resetDbForTests } from "./db";
import type { SetInsert } from "./types";

function makeSet(id: string): SetInsert {
  return {
    id,
    session_id: "sess-1",
    exercise_id: "Barbell_Squat",
    prescription_id: null,
    set_index: 0,
    set_type: "working",
    load_kg: 100,
    reps: 5,
    performed_at: "2026-09-16T10:00:00.000Z",
    rest_seconds_actual: null,
  };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
});

describe("outbox: flush on visibilitychange", () => {
  it("flushes a write queued while hidden once the tab is visible again", async () => {
    let online = false;
    const calls: unknown[] = [];
    const transport: OutboxTransport = {
      async insert(_table, payload) {
        calls.push(payload);
        return null;
      },
      async update() {
        return null;
      },
    };
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => online,
      currentUserId: () => "alice",
    });

    box.start();
    await box.enqueue({
      kind: "insert",
      table: "sets",
      payload: makeSet("aaaa9999-1111-4111-8111-111111111111"),
    });
    expect(calls).toHaveLength(0); // offline: nothing sent yet

    online = true; // the network was fine; the TAB was just hidden
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it("does nothing on a visibilitychange to hidden", async () => {
    const calls: unknown[] = [];
    const transport: OutboxTransport = {
      async insert(_table, payload) {
        calls.push(payload);
        return null;
      },
      async update() {
        return null;
      },
    };
    const box = createOutbox({
      getDb,
      transport,
      isOnline: () => true,
      currentUserId: () => "alice",
    });
    box.start();
    await box.enqueue({
      kind: "insert",
      table: "sets",
      payload: makeSet("bbbb9999-1111-4111-8111-111111111111"),
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    calls.length = 0;
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0); // nothing re-sent, nothing new to send
  });
});
