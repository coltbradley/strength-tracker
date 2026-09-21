import { describe, it, expect } from "vitest";
import { assertProductionSupabaseEnv } from "./supabaseEnv";

const URL = "https://abcdefghijklmnop.supabase.co";
const KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("assertProductionSupabaseEnv", () => {
  it("throws in production when the URL is the placeholder", () => {
    expect(() =>
      assertProductionSupabaseEnv(
        "https://placeholder.supabase.co",
        KEY,
        true,
        false,
      ),
    ).toThrow(/VITE_SUPABASE_URL/);
  });

  it("throws in production when the anon key is missing", () => {
    expect(() =>
      assertProductionSupabaseEnv(URL, undefined, true, false),
    ).toThrow(/VITE_SUPABASE_ANON_KEY/);
  });

  it("does not throw in dev with placeholders", () => {
    expect(() =>
      assertProductionSupabaseEnv(
        "https://placeholder.supabase.co",
        "placeholder-anon-key",
        false,
        false,
      ),
    ).not.toThrow();
  });

  it("does not throw in demo mode", () => {
    expect(() =>
      assertProductionSupabaseEnv(undefined, undefined, true, true),
    ).not.toThrow();
  });

  it("does not throw for a real production pair", () => {
    expect(() =>
      assertProductionSupabaseEnv(URL, KEY, true, false),
    ).not.toThrow();
  });
});
