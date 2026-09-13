// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  getAuthorizationDetails: vi.fn(),
  approveAuthorization: vi.fn(),
  denyAuthorization: vi.fn(),
  signOut: vi.fn(() => Promise.resolve({ error: null })),
  assign: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
      signOut: h.signOut,
      oauth: {
        getAuthorizationDetails: h.getAuthorizationDetails,
        approveAuthorization: h.approveAuthorization,
        denyAuthorization: h.denyAuthorization,
      },
    },
  },
  supabaseConfigured: true,
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));

import { OAuthConsent } from "./OAuthConsent";

const DETAILS = {
  authorization_id: "auth-1",
  redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
  client: {
    id: "c1",
    name: "ChatGPT",
    uri: "https://chatgpt.com",
    logo_uri: "",
  },
  user: { id: "u1", email: "val@example.com" },
  scope: "openid email",
};

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    "/oauth/consent?authorization_id=auth-1",
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      assign: h.assign,
      search: "?authorization_id=auth-1",
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OAuthConsent", () => {
  it("names the client, the destination host and the account before asking", async () => {
    h.getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null });
    render(<OAuthConsent email="val@example.com" />);
    expect(
      await screen.findByText("ChatGPT wants to use your Strength Log"),
    ).toBeTruthy();
    expect(screen.getByText(/chatgpt\.com/)).toBeTruthy();
    expect(screen.getByText(/val@example\.com/)).toBeTruthy();
    expect(screen.getByText(/never change a logged set/i)).toBeTruthy();
  });

  it("approves and follows the redirect Supabase returns", async () => {
    h.getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null });
    h.approveAuthorization.mockResolvedValue({
      data: { redirect_url: "https://chatgpt.com/cb?code=x&state=y" },
      error: null,
    });
    render(<OAuthConsent email="val@example.com" />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await vi.waitFor(() =>
      expect(h.assign).toHaveBeenCalledWith(
        "https://chatgpt.com/cb?code=x&state=y",
      ),
    );
    expect(h.approveAuthorization).toHaveBeenCalledWith("auth-1", {
      skipBrowserRedirect: true,
    });
  });

  it("denies and still returns the lifter to the client", async () => {
    h.getAuthorizationDetails.mockResolvedValue({ data: DETAILS, error: null });
    h.denyAuthorization.mockResolvedValue({
      data: { redirect_url: "https://chatgpt.com/cb?error=access_denied" },
      error: null,
    });
    render(<OAuthConsent email="val@example.com" />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await vi.waitFor(() =>
      expect(h.assign).toHaveBeenCalledWith(
        "https://chatgpt.com/cb?error=access_denied",
      ),
    );
  });

  it("skips the question when consent was already given", async () => {
    h.getAuthorizationDetails.mockResolvedValue({
      data: { redirect_url: "https://chatgpt.com/cb?code=z" },
      error: null,
    });
    render(<OAuthConsent email="val@example.com" />);
    await vi.waitFor(() =>
      expect(h.assign).toHaveBeenCalledWith("https://chatgpt.com/cb?code=z"),
    );
  });

  it("says the request expired instead of showing a broken page", async () => {
    h.getAuthorizationDetails.mockResolvedValue({
      data: null,
      error: { message: "not found" },
    });
    render(<OAuthConsent email="val@example.com" />);
    expect(
      await screen.findByText(/this sign-in request has expired/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});
