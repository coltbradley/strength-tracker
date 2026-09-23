// The outbox stamps an owner at enqueue time, synchronously, during the
// same module evaluation that starts the queue. getSession() is still in
// flight then. The id has to come from this project's stored session, or
// the first write of the boot is queued with no owner.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
const onAuthStateChange = vi.hoisted(() =>
  vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
);

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession,
      onAuthStateChange,
    },
  },
}));

const REF = "abcdefghijklmnop";
const ALICE = "aaaaaaaa-1111-4111-8111-111111111111";
const BOB = "bbbbbbbb-2222-4222-8222-222222222222";

function memoryStore(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

function sessionJson(id: string): string {
  return JSON.stringify({
    access_token: "at",
    refresh_token: "rt",
    user: { id },
  });
}

describe("getCurrentUserId boot seed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.resetModules();
    getSession.mockReset();
    onAuthStateChange.mockClear();
    vi.stubEnv("VITE_SUPABASE_URL", `https://${REF}.supabase.co`);
    vi.stubGlobal("localStorage", memoryStore({}));
  });

  it("is the configured project's persisted id before getSession resolves", async () => {
    getSession.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal(
      "localStorage",
      memoryStore({
        "sb-otherprojectref-auth-token": sessionJson(BOB),
        [`sb-${REF}-auth-token`]: sessionJson(ALICE),
      }),
    );

    const { getCurrentUserId } = await import("./currentUser");
    expect(getCurrentUserId()).toBe(ALICE);
  });

  it("stays null when the only stored session belongs to another project", async () => {
    getSession.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal(
      "localStorage",
      memoryStore({
        "sb-otherprojectref-auth-token": sessionJson(BOB),
      }),
    );

    const { getCurrentUserId } = await import("./currentUser");
    expect(getCurrentUserId()).toBeNull();
  });

  it("clears the seed when getSession reports a real sign-out", async () => {
    let resolveSession: (value: unknown) => void = () => undefined;
    getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    vi.stubGlobal(
      "localStorage",
      memoryStore({ [`sb-${REF}-auth-token`]: sessionJson(ALICE) }),
    );

    const { getCurrentUserId } = await import("./currentUser");
    expect(getCurrentUserId()).toBe(ALICE);

    resolveSession({ data: { session: null }, error: null });
    await Promise.resolve();
    expect(getCurrentUserId()).toBeNull();
  });
});
