// @vitest-environment jsdom
// The demo's stand-in client must speak every query shape the app uses, or a
// harmless demo run paints a red toast that hides a real regression.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSupabase } from "./mockSupabase";
import { getExercisePrefRows } from "../lib/data";

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (t: string) => (h.client as { from(t: string): unknown }).from(t),
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  },
}));

type Mock = Awaited<ReturnType<typeof createMockSupabase>>;
beforeEach(async () => {
  h.client = await createMockSupabase();
});

describe("mock supabase", () => {
  it(".range returns the inclusive window of the ordered rows", async () => {
    const mock = h.client as Mock;
    const { data } = await mock
      .from("exercises")
      .select("id")
      .order("id", { ascending: true })
      .range(1, 3);
    expect(data).toHaveLength(3);
    const all = await mock.from("exercises").select("id").order("id", { ascending: true });
    expect((data as { id: string }[]).map((r) => r.id)).toEqual(
      (all.data as { id: string }[]).slice(1, 4).map((r) => r.id),
    );
  });

  it("lets getExercisePrefRows page exercise_prefs without throwing", async () => {
    await expect(getExercisePrefRows()).resolves.toEqual([]);
  });

  it("serves the coach_observations relation", async () => {
    const { data, error } = await (h.client as Mock)
      .from("coach_observations")
      .select("id, topic, observation, check_back_on")
      .eq("status", "open")
      .order("check_back_on", { ascending: true });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
