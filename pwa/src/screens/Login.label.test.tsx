// @vitest-environment jsdom
// UI-07 (deeper pass): the email field had only a visual "EMAIL" caption, so a
// screen reader announced an unnamed text box on the one screen a signed-out
// person has to get through.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", () => ({
  supabase: { auth: { signInWithOtp: vi.fn(), verifyOtp: vi.fn() } },
  supabaseConfigured: true,
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));

import { Login } from "./Login";

describe("UI-07: Login email field", () => {
  it("has an accessible name", () => {
    render(<Login />);
    expect(screen.getByRole("textbox", { name: "EMAIL" })).toBeTruthy();
  });
});
