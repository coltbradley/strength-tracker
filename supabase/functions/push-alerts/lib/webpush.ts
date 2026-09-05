// Web Push, from WebCrypto alone.
//
// Two RFCs, one file. RFC 8291 says how a push message is encrypted so that
// only the browser that subscribed can read it (ECDH on P-256, HKDF, AES-128-GCM
// in the RFC 8188 "aes128gcm" framing). RFC 8292 says how the sender proves
// who it is to the push service (VAPID: an ES256 JWT over the endpoint's
// origin, signed with a key the browser was shown at subscribe time).
//
// WHY NOT A LIBRARY: `web-push` on npm reaches for Node's `crypto` module,
// which Deno emulates but not completely, and the alternatives that do use
// WebCrypto pull in helper packages of their own. Everything both RFCs need is
// in `crypto.subtle` — ECDH, HKDF, AES-GCM, ECDSA — so the honest dependency
// count is zero, and the whole thing is pinned by RFC 8291's own Appendix A
// test vector in webpush_test.ts. A wrong byte anywhere in here fails that
// test; a library that changed under us would not.
//
// This module is PURE: no Deno.env, no database, no logging. It takes bytes
// and keys and returns bytes and headers. That is what lets the test run with
// no permissions and what keeps the endpoint and the keys out of any log line
// by construction — nothing here has a logger to leak them to.

// ---- encoding ---------------------------------------------------------------

const enc = new TextEncoder();

/** Bytes backed by a real ArrayBuffer, which is what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** base64url without padding, the alphabet every Web Push field uses. */
export function toBase64Url(bytes: Bytes): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Bytes {
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---- RFC 8291: message encryption -----------------------------------------

/** What the browser handed the app at subscribe time. */
export interface SubscriptionKeys {
  /** 65-byte uncompressed P-256 point, base64url */
  p256dh: string;
  /** 16-byte auth secret, base64url */
  auth: string;
}

/** The sender's side of the ECDH exchange. Ephemeral per message in
 *  production; fixed in the RFC's test vector. */
export interface SenderKeys {
  privateKey: CryptoKey;
  /** 65-byte uncompressed point */
  publicKeyBytes: Bytes;
}

/** RFC 8188 record size. A push service must accept 4096 octets in total, so
 *  one record is the whole message; the header comes out of the same budget. */
const RECORD_SIZE = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65;
/** One delimiter byte plus the 16-byte GCM tag. */
const RECORD_OVERHEAD = 1 + 16;
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - RECORD_OVERHEAD;

async function hkdf(
  salt: Bytes,
  ikm: Bytes,
  info: Bytes,
  bytes: number,
): Promise<Bytes> {
  // WebCrypto's HKDF is extract-then-expand in one call, which is exactly the
  // shape RFC 8291 §3.3 and §3.4 use it in.
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export async function generateSenderKeys(): Promise<SenderKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return {
    privateKey: pair.privateKey,
    publicKeyBytes: new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    ),
  };
}

/** The intermediate values of RFC 8291 §3, exposed so the test can pin each
 *  step and not just the final ciphertext: a failure then names the step. */
export interface DerivedKeys {
  /** the content encryption key, 16 bytes */
  cek: Bytes;
  /** the GCM nonce, 12 bytes */
  nonce: Bytes;
  /** the HKDF-derived input keying material, 32 bytes (§3.4) */
  ikm: Bytes;
  /** the raw ECDH shared secret, 32 bytes (§3.1) */
  ecdhSecret: Bytes;
}

export async function deriveKeys(
  subscription: SubscriptionKeys,
  sender: SenderKeys,
  salt: Bytes,
): Promise<DerivedKeys> {
  const uaPublic = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error("p256dh is not an uncompressed P-256 point");
  }
  if (authSecret.length !== 16) {
    throw new Error("auth secret is not 16 bytes");
  }

  // §3.1: ECDH between the sender's ephemeral key and the browser's key.
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      sender.privateKey,
      256,
    ),
  );

  // §3.3 + §3.4: fold the auth secret in, bound to both public keys.
  const keyInfo = concat(
    enc.encode("WebPush: info\0"),
    uaPublic,
    sender.publicKeyBytes,
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 §2.2: content key and nonce from the salt.
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  return { cek, nonce, ikm, ecdhSecret };
}

/**
 * Encrypt one push message body (RFC 8291 §4 framing: header, then a single
 * aes128gcm record).
 *
 * `sender` and `salt` are parameters rather than generated in here for one
 * reason: the RFC's test vector fixes both, and a function that draws its own
 * randomness cannot be tested against a known answer. Production callers pass
 * nothing and get fresh values.
 */
export async function encryptPayload(
  plaintext: Bytes,
  subscription: SubscriptionKeys,
  fixed?: { sender: SenderKeys; salt: Bytes },
): Promise<Bytes> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(
      `payload is ${plaintext.length} bytes; the most a push service must accept is ${MAX_PLAINTEXT_BYTES}`,
    );
  }
  const sender = fixed?.sender ?? (await generateSenderKeys());
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await deriveKeys(subscription, sender, salt);

  // RFC 8188 §2: the record is plaintext, then a delimiter — 0x02 for the
  // last (here the only) record — then any padding. No padding: the message
  // is a few dozen bytes and nobody is inferring set counts from its length.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const key = await crypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM", length: 128 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record),
  );

  // RFC 8188 §2.1 header: salt(16) | rs(4, big-endian) | idlen(1) | keyid.
  // For Web Push the key id IS the sender's public key (RFC 8291 §4).
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
  return concat(
    salt,
    rs,
    new Uint8Array([sender.publicKeyBytes.length]),
    sender.publicKeyBytes,
    ciphertext,
  );
}

// ---- RFC 8292: VAPID ------------------------------------------------------

/** The deployment's signing pair, as stored in push_config. */
export interface VapidKeys {
  /** 65-byte uncompressed P-256 point, base64url — what the browser is shown */
  publicKey: string;
  /** the private half, as the JWK WebCrypto exported */
  privateJwk: JsonWebKey;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey, privateJwk };
}

/** The claims a push service checks (RFC 8292 §2). */
export interface VapidClaims {
  /** the push service's origin: scheme + host of the endpoint, nothing else */
  aud: string;
  /** seconds since the epoch; at most 24 h out */
  exp: number;
  /** a contact URI: mailto: or https: */
  sub: string;
}

/**
 * The `Authorization` header value for one request to a push service.
 *
 * RFC 8292 §3: `vapid t=<JWT>, k=<public key>`. The JWT is JWS compact
 * serialisation with ES256, and WebCrypto's ECDSA signature is already the raw
 * r||s form JWS wants — no DER to unwrap.
 */
export async function vapidAuthorization(
  keys: VapidKeys,
  claims: VapidClaims,
): Promise<string> {
  const header = toBase64Url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = toBase64Url(enc.encode(JSON.stringify(claims)));
  const signingInput = enc.encode(`${header}.${body}`);
  const key = await crypto.subtle.importKey(
    "jwk",
    keys.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signingInput,
    ),
  );
  return `vapid t=${header}.${body}.${toBase64Url(sig)}, k=${keys.publicKey}`;
}

/**
 * Check a VAPID token against the public key — used by the test to prove that
 * what vapidAuthorization signs is what a push service will verify, without
 * a push service in the loop.
 */
export async function verifyVapidToken(
  token: string,
  publicKey: string,
): Promise<VapidClaims | null> {
  const [header, body, sig] = token.split(".");
  if (!header || !body || !sig) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64Url(sig),
    enc.encode(`${header}.${body}`),
  );
  if (!ok) return null;
  return JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as VapidClaims;
}

// ---- one request ------------------------------------------------------------

export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Bytes;
}

/**
 * Everything one push needs: encrypted body plus the headers RFC 8291 §4 and
 * RFC 8292 §3 require. The caller does the fetch, so this stays testable and
 * so the module never sees a network.
 *
 * `ttl` is how long the push service may hold the message for an offline
 * device; `topic` lets a newer message replace an older undelivered one.
 */
export async function buildPushRequest(a: {
  endpoint: string;
  subscription: SubscriptionKeys;
  payload: Bytes;
  vapid: VapidKeys;
  subject: string;
  ttlSeconds: number;
  topic?: string;
  urgency?: "very-low" | "low" | "normal" | "high";
  now?: number;
}): Promise<PushRequest> {
  const origin = new URL(a.endpoint).origin;
  const nowSec = Math.floor((a.now ?? Date.now()) / 1000);
  const authorization = await vapidAuthorization(a.vapid, {
    aud: origin,
    // 12 h: well inside the 24 h ceiling, long enough that clock skew between
    // here and the push service cannot make a fresh token look expired.
    exp: nowSec + 12 * 3600,
    sub: a.subject,
  });
  const body = await encryptPayload(a.payload, a.subscription);
  const headers: Record<string, string> = {
    authorization,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(a.ttlSeconds),
  };
  if (a.topic) headers.topic = a.topic;
  if (a.urgency) headers.urgency = a.urgency;
  return { endpoint: a.endpoint, headers, body };
}
