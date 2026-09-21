import { assertEquals } from "jsr:@std/assert@^1";
import { isAllowedPushEndpoint } from "./endpoint.ts";

Deno.test("allows known push origins", () => {
  assertEquals(
    isAllowedPushEndpoint("https://web.push.apple.com/QAbc123"),
    true,
  );
  assertEquals(
    isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"),
    true,
  );
});

Deno.test("rejects loopback, link-local, and metadata IPs", () => {
  assertEquals(isAllowedPushEndpoint("https://127.0.0.1/"), false);
  assertEquals(isAllowedPushEndpoint("https://169.254.169.254/latest"), false);
  assertEquals(isAllowedPushEndpoint("https://localhost/x"), false);
  assertEquals(isAllowedPushEndpoint("http://web.push.apple.com/x"), false);
});
