// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ listGrants: vi.fn(), revokeGrant: vi.fn() }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: { oauth: { listGrants: h.listGrants, revokeGrant: h.revokeGrant } },
  },
  supabaseConfigured: true,
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn() }));

import { ConnectedApps } from "./ConnectedApps";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const GRANT = {
  client: { id: "c1", name: "ChatGPT", uri: "", logo_uri: "" },
  scopes: ["openid"],
  granted_at: "2026-09-13T10:00:00Z",
};

describe("ConnectedApps", () => {
  it("lists each connected app with a disconnect action", async () => {
    h.listGrants.mockResolvedValue({ data: [GRANT], error: null });
    render(<ConnectedApps />);
    expect(await screen.findByText("ChatGPT")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Disconnect ChatGPT" }),
    ).toBeTruthy();
  });

  it("revokes by client id and removes the row", async () => {
    h.listGrants.mockResolvedValue({ data: [GRANT], error: null });
    h.revokeGrant.mockResolvedValue({ data: {}, error: null });
    render(<ConnectedApps />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect ChatGPT" }),
    );
    await vi.waitFor(() =>
      expect(h.revokeGrant).toHaveBeenCalledWith({ clientId: "c1" }),
    );
    await vi.waitFor(() => expect(screen.queryByText("ChatGPT")).toBeNull());
  });

  it("says none rather than rendering an empty list", async () => {
    h.listGrants.mockResolvedValue({ data: [], error: null });
    render(<ConnectedApps />);
    expect(await screen.findByText("NONE")).toBeTruthy();
  });

  it("says it could not load rather than claiming there are none", async () => {
    h.listGrants.mockResolvedValue({ data: null, error: { message: "boom" } });
    render(<ConnectedApps />);
    expect(await screen.findByText("COULDN'T LOAD")).toBeTruthy();
    expect(screen.queryByText("NONE")).toBeNull();
  });
});
