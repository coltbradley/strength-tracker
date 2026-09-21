import { assertEquals } from "jsr:@std/assert@^1";
import { postToPushEndpoint } from "./push-to-endpoint.ts";
import { generateVapidKeys, type Bytes } from "./webpush.ts";

const UA_PUBLIC =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";

Deno.test(
  "send path refuses a stored localhost endpoint without fetching",
  async () => {
    const vapid = await generateVapidKeys();
    let fetchCalls = 0;
    const result = await postToPushEndpoint({
      endpoint: "https://127.0.0.1/evil",
      subscription: { p256dh: UA_PUBLIC, auth: AUTH_SECRET },
      payload: new TextEncoder().encode("{}") as Bytes,
      vapid,
      subject: "https://example.test",
      ttlSeconds: 90,
      fetchFn: () => {
        fetchCalls++;
        return Promise.resolve(new Response("", { status: 200 }));
      },
    });
    assertEquals(fetchCalls, 0);
    assertEquals(result.blocked, true);
    assertEquals(result.ok, false);
  },
);

Deno.test(
  "send path refuses a stored IPv4 literal endpoint without fetching",
  async () => {
    const vapid = await generateVapidKeys();
    let fetchCalls = 0;
    const result = await postToPushEndpoint({
      endpoint: "https://192.0.2.1/push",
      subscription: { p256dh: UA_PUBLIC, auth: AUTH_SECRET },
      payload: new TextEncoder().encode("{}") as Bytes,
      vapid,
      subject: "https://example.test",
      ttlSeconds: 90,
      fetchFn: () => {
        fetchCalls++;
        return Promise.resolve(new Response("", { status: 200 }));
      },
    });
    assertEquals(fetchCalls, 0);
    assertEquals(result.blocked, true);
  },
);
