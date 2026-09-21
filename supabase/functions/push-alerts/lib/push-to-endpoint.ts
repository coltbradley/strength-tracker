import { isAllowedPushEndpoint } from "./endpoint.ts";
import { buildPushRequest, type Bytes, type VapidKeys } from "./webpush.ts";

export type PushEndpointSendResult = {
  ok: boolean;
  status: number;
  /** Endpoint failed the send-time allowlist; fetch was not attempted. */
  blocked?: boolean;
  error?: string;
};

/** POST an encrypted payload to one stored subscription endpoint. */
export async function postToPushEndpoint(a: {
  endpoint: string;
  subscription: { p256dh: string; auth: string };
  payload: Bytes;
  vapid: VapidKeys;
  subject: string;
  ttlSeconds: number;
  topic?: string;
  urgency?: "very-low" | "low" | "normal" | "high";
  fetchFn?: typeof fetch;
}): Promise<PushEndpointSendResult> {
  if (!isAllowedPushEndpoint(a.endpoint)) {
    return { ok: false, status: 0, blocked: true };
  }
  const fetchFn = a.fetchFn ?? fetch;
  try {
    const push = await buildPushRequest({
      endpoint: a.endpoint,
      subscription: a.subscription,
      payload: a.payload,
      vapid: a.vapid,
      subject: a.subject,
      ttlSeconds: a.ttlSeconds,
      topic: a.topic,
      urgency: a.urgency,
    });
    const res = await fetchFn(push.endpoint, {
      method: "POST",
      headers: push.headers,
      body: push.body,
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
