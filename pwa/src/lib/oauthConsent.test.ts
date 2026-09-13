import { describe, expect, it } from "vitest";
import {
  authorizationIdFrom,
  isConsentPath,
  redirectHost,
} from "./oauthConsent";

describe("oauthConsent helpers", () => {
  it("recognises the consent path under the Pages base and at root", () => {
    expect(
      isConsentPath("/strength-tracker/oauth/consent", "/strength-tracker/"),
    ).toBe(true);
    expect(
      isConsentPath("/strength-tracker/oauth/consent/", "/strength-tracker/"),
    ).toBe(true);
    expect(isConsentPath("/oauth/consent", "/")).toBe(true);
    expect(isConsentPath("/strength-tracker/", "/strength-tracker/")).toBe(
      false,
    );
    expect(
      isConsentPath("/strength-tracker/program", "/strength-tracker/"),
    ).toBe(false);
  });

  it("reads the authorization id and refuses anything that is not a plain id", () => {
    expect(authorizationIdFrom("?authorization_id=abc-123")).toBe("abc-123");
    expect(authorizationIdFrom("")).toBeNull();
    expect(authorizationIdFrom("?authorization_id=")).toBeNull();
    expect(authorizationIdFrom("?authorization_id=a%2Fb")).toBeNull();
  });

  it("shows only the host of where the lifter will be sent", () => {
    expect(
      redirectHost("https://chatgpt.com/connector_platform_oauth_redirect"),
    ).toBe("chatgpt.com");
    expect(redirectHost("http://127.0.0.1:8976/callback")).toBe("127.0.0.1");
    expect(redirectHost("not a url")).toBeNull();
  });
});
