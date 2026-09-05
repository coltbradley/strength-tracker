// @vitest-environment jsdom
//
// The sign-out warning said "Signing out discards them, this is the only
// copy", and it was false in both halves. Nothing in the sign-out path touches
// the outbox: `cacheClearAll` drops the read cache and leaves the queue alone
// on purpose, and every queued item carries its owner so the flusher replays
// it for the person who made it. The button directly beneath the warning
// already said "kept for you", so the sheet contradicted itself, and a warning
// that overstates is how a user learns to skip the ones that are real.
//
// What is pinned here: the copy appears when, and only when, there is
// something outstanding to say it about, and it never promises a deletion.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsSheet } from "./SettingsSheet";

const h = vi.hoisted(() => ({
  status: {
    pending: 0,
    dead: 0,
    held: 0,
    state: "idle" as const,
    lastError: null as string | null,
  },
}));

vi.mock("../lib/sync", () => ({
  outbox: {
    getStatus: () => h.status,
    subscribe: () => () => {},
    flush: () => Promise.resolve(),
    inspect: () => Promise.resolve([]),
    retryDead: () => Promise.resolve({ requeued: 0, stuck: 0 }),
  },
}));

vi.mock("../lib/supabase", () => ({
  supabase: { auth: { signOut: () => Promise.resolve({ error: null }) } },
  supabaseConfigured: true,
}));

// Real module, minus the two reads this sheet fires on open — neither has
// anything to do with the queue, and both would go to the network.
vi.mock("../lib/data", async (orig) => ({
  ...(await orig<typeof import("../lib/data")>()),
  getExercises: () => Promise.resolve({ data: [], fromCache: false }),
  getTrainingMaxes: () => Promise.resolve({ data: [], fromCache: false }),
}));

afterEach(cleanup);

/** Render with a given queue state and arm the sign-out button.
 *  <Sheet> portals to document.body, so every query below reads
 *  `baseElement` rather than the render container, which is empty. */
function arm(queue: { pending: number; dead: number; held?: number }) {
  h.status = { ...h.status, held: 0, ...queue };
  const view = render(<SettingsSheet open onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  return view;
}

describe("SettingsSheet sign-out", () => {
  it("says nothing about unsynced work when there is none", () => {
    const { baseElement } = arm({ pending: 0, dead: 0 });
    expect(baseElement.querySelector(".settings-warn")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out?" })).toBeTruthy();
  });

  it("states what actually happens to outstanding writes", () => {
    const { baseElement } = arm({ pending: 3, dead: 0 });
    const warn = baseElement.querySelector(".settings-warn");
    expect(warn).not.toBeNull();
    const copy = warn!.textContent ?? "";

    expect(copy).toContain("3 writes have not reached the server.");
    expect(copy).toContain("Signing out does not delete them");
    expect(copy).toContain("under the account that made each one");
    // The half that IS destructive, and was never mentioned before.
    expect(copy).toContain("The rest of your log is cleared from this device");
    // The old lie, in either spelling.
    expect(copy).not.toMatch(/discard/i);
    expect(copy).not.toMatch(/only copy/i);
  });

  it("names the failed ones, which do not go on their own", () => {
    const { baseElement } = arm({ pending: 2, dead: 1 });
    const copy = baseElement.querySelector(".settings-warn")?.textContent ?? "";
    expect(copy).toContain("3 writes have not reached the server.");
    expect(copy).toContain("One of them has failed");
    expect(copy).toContain("Unsynced writes");
    // "Sync now" is not the remedy for a dead item, so it is not offered.
    expect(copy).not.toContain("if you have signal");
  });

  it("keeps quiet until the button is armed", () => {
    h.status = { ...h.status, pending: 4, dead: 0, held: 0 };
    const { baseElement } = render(
      <SettingsSheet open onClose={() => undefined} />,
    );
    expect(baseElement.querySelector(".settings-warn")).toBeNull();
    // ...and the unarmed button does not shout either
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("counts held writes as outstanding, because they are", () => {
    // A held item is queued by another account on this phone. It is unsynced
    // training either way, and staying silent about it is the same omission
    // this copy exists to fix.
    const { baseElement } = arm({ pending: 2, dead: 0, held: 2 });
    const copy = baseElement.querySelector(".settings-warn")?.textContent ?? "";
    expect(copy).toContain("2 writes have not reached the server.");
  });
});
