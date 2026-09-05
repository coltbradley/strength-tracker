// RFC 8291 Appendix A, byte for byte.
//
// The RFC publishes one complete worked example: fixed sender and receiver
// keys, a fixed salt, a fixed auth secret, the plaintext "When I grow up, I
// want to be a watermelon", and every intermediate value down to the final
// 144-byte message. An implementation that reproduces the final bytes has
// every step right, because AES-GCM is unforgiving about a single wrong bit
// in the key, the nonce or the framing. The intermediates are asserted too, so
// a regression names the step that broke rather than only the fact that
// something did.
//
// No assertion library: jsr.io is not reachable from every place this runs,
// and three comparisons do not need one.

import {
  buildPushRequest,
  deriveKeys,
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  toBase64Url,
  vapidAuthorization,
  verifyVapidToken,
  type SenderKeys,
} from "./webpush.ts";

function assertEquals(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}\n  expected ${e}\n  got      ${a}`);
}

// ---- the vector ------------------------------------------------------------

const PLAINTEXT = "When I grow up, I want to be a watermelon";

// Application server (the sender) keys
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const AS_PUBLIC =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

// User agent (the browser) keys — what a subscription carries
const UA_PUBLIC =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";

const SALT = "DGv6ra1nlYgDCS1FRnbzlw";

// Intermediate values (§A)
const ECDH_SECRET = "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs";
const IKM = "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg";
const CEK = "oIhVW04MRdy2XN9CiKLxTg";
const NONCE = "4h_95klXJ5E_qnoN";

// The whole message: header (salt, rs, idlen, as_public) then the record
const EXPECTED =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

/** The RFC gives the sender's private scalar and public point separately; a
 *  JWK carries both, so import them as one key. */
async function senderFromVector(): Promise<SenderKeys> {
  const pub = fromBase64Url(AS_PUBLIC);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: AS_PRIVATE,
      x: toBase64Url(pub.slice(1, 33)),
      y: toBase64Url(pub.slice(33, 65)),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return { privateKey, publicKeyBytes: pub };
}

Deno.test("RFC 8291 Appendix A: every intermediate value", async () => {
  const sender = await senderFromVector();
  const d = await deriveKeys(
    { p256dh: UA_PUBLIC, auth: AUTH_SECRET },
    sender,
    fromBase64Url(SALT),
  );
  assertEquals(toBase64Url(d.ecdhSecret), ECDH_SECRET, "ecdh_secret (§3.1)");
  assertEquals(toBase64Url(d.ikm), IKM, "IKM (§3.4)");
  assertEquals(toBase64Url(d.cek), CEK, "CEK");
  assertEquals(toBase64Url(d.nonce), NONCE, "NONCE");
});

Deno.test("RFC 8291 Appendix A: the final message", async () => {
  const sender = await senderFromVector();
  const out = await encryptPayload(
    new TextEncoder().encode(PLAINTEXT),
    { p256dh: UA_PUBLIC, auth: AUTH_SECRET },
    { sender, salt: fromBase64Url(SALT) },
  );
  assertEquals(
    out.length,
    86 + PLAINTEXT.length + 1 + 16,
    "message length: 86-byte header, then plaintext + delimiter + GCM tag",
  );
  assertEquals(toBase64Url(out), EXPECTED, "ciphertext");
});

Deno.test("base64url round-trips and never pads", () => {
  for (const s of [AS_PUBLIC, UA_PUBLIC, AUTH_SECRET, SALT, EXPECTED]) {
    assertEquals(toBase64Url(fromBase64Url(s)), s, `round trip ${s.slice(0, 8)}`);
  }
  assertEquals(toBase64Url(new Uint8Array([0])), "AA", "one byte, no '='");
});

Deno.test("a message a push service must accept is refused when too long", async () => {
  const sender = await senderFromVector();
  let threw = false;
  try {
    await encryptPayload(
      new Uint8Array(5000),
      { p256dh: UA_PUBLIC, auth: AUTH_SECRET },
      { sender, salt: fromBase64Url(SALT) },
    );
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "5000 bytes refused");
});

// ---- RFC 8292 -----------------------------------------------------------------

Deno.test("VAPID: the token verifies against the public key and carries the claims", async () => {
  const keys = await generateVapidKeys();
  assertEquals(fromBase64Url(keys.publicKey).length, 65, "public key is a raw P-256 point");
  assertEquals(fromBase64Url(keys.publicKey)[0], 4, "uncompressed");
  const claims = { aud: "https://web.push.apple.com", exp: 1_800_000_000, sub: "https://example.test" };
  const auth = await vapidAuthorization(keys, claims);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  if (!m) throw new Error(`header shape: ${auth}`);
  assertEquals(m[2], keys.publicKey, "k= is the public key");
  const verified = await verifyVapidToken(m[1], keys.publicKey);
  assertEquals(verified, claims, "claims round-trip under a valid signature");
  // and a different key does not verify it
  const other = await generateVapidKeys();
  assertEquals(await verifyVapidToken(m[1], other.publicKey), null, "wrong key rejects");
});

Deno.test("a push request carries the headers both RFCs require", async () => {
  const keys = await generateVapidKeys();
  const req = await buildPushRequest({
    endpoint: "https://web.push.apple.com/QAbc123",
    subscription: { p256dh: UA_PUBLIC, auth: AUTH_SECRET },
    payload: new TextEncoder().encode(JSON.stringify({ title: "Rest over" })),
    vapid: keys,
    subject: "https://example.test",
    ttlSeconds: 90,
    topic: "rest",
    urgency: "high",
    now: 1_700_000_000_000,
  });
  assertEquals(req.headers["content-encoding"], "aes128gcm", "content-encoding");
  assertEquals(req.headers["content-type"], "application/octet-stream", "content-type");
  assertEquals(req.headers.ttl, "90", "TTL");
  assertEquals(req.headers.topic, "rest", "Topic");
  assertEquals(req.headers.urgency, "high", "Urgency");
  const t = /^vapid t=([^,]+), k=/.exec(req.headers.authorization)?.[1] ?? "";
  const claims = await verifyVapidToken(t, keys.publicKey);
  assertEquals(claims?.aud, "https://web.push.apple.com", "aud is the endpoint's origin only");
  assertEquals(claims?.exp, 1_700_000_000 + 12 * 3600, "exp 12 h out");
  // the header is 86 bytes and the sender key sits at offset 21
  assertEquals(req.body[20], 65, "idlen");
  assertEquals(req.body[21], 4, "sender key is an uncompressed point");
});
