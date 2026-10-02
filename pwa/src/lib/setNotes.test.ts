import { describe, expect, it } from "vitest";
import { mergeSetNotes, pendingNoteSetIds } from "./setNotes";
import type { OutboxEntry } from "./outbox";

const entry = (table: string, set_id: string): OutboxEntry =>
  ({
    op: { kind: "insert", table, payload: { set_id, note: "x" } },
    table,
  }) as never;

describe("mergeSetNotes", () => {
  it("UI-21: a fresh server note replaces an acknowledged stale cached one", () => {
    expect(
      mergeSetNotes(
        { a: "Newer server note" },
        { a: "Older cached note" },
        new Set(),
      ),
    ).toEqual({ a: "Newer server note" });
  });

  it("UI-21: a note still owed to the server keeps its local text", () => {
    expect(
      mergeSetNotes({ a: "server" }, { a: "typed offline" }, new Set(["a"])),
    ).toEqual({ a: "typed offline" });
  });

  it("keeps a local note the server does not list, and adds new server notes", () => {
    expect(
      mergeSetNotes({ b: "other device" }, { a: "in flight" }, new Set()),
    ).toEqual({
      a: "in flight",
      b: "other device",
    });
  });

  it("pendingNoteSetIds picks only set_notes inserts", () => {
    expect(
      pendingNoteSetIds([entry("set_notes", "a"), entry("set_voids", "b")]),
    ).toEqual(new Set(["a"]));
  });
});
